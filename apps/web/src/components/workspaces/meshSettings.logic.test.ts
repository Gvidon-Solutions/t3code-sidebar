import { buildMeshMachines } from "@t3tools/client-runtime/state/mesh-machines";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  linkSourceOptions,
  linkTargetOptions,
  meshUpdateProblems,
  meshUpdatePrompt,
  offlineMachinePrompt,
  plainFailureText,
  showsLinkSourcePicker,
  shouldOfferConnect,
} from "./meshSettings.logic";
import { meshProjectRows, meshSetupPrompt } from "@t3tools/client-runtime/state/mesh-machines";

const environment = (
  environmentId: string,
  label: string,
  overrides: {
    connected?: boolean;
    peerLinks?: boolean;
    linkedEnvironmentsEnabled?: boolean;
  } = {},
) => ({
  environmentId,
  label,
  connection: { phase: overrides.connected === false ? "offline" : "connected" },
  serverConfig: {
    settings: { linkedEnvironmentsEnabled: overrides.linkedEnvironmentsEnabled !== false },
    environment: { capabilities: { peerLinks: overrides.peerLinks !== false } },
  },
});

describe("linkSourceOptions", () => {
  it("keeps connected machines that offer links and have the beta on", () => {
    expect(
      linkSourceOptions([
        environment("atlas", "Atlas"),
        environment("lab", "lab", { connected: false }),
        environment("vps", "VPS", { peerLinks: false }),
        environment("old", "Old", { linkedEnvironmentsEnabled: false }),
      ]),
    ).toEqual([{ environmentId: "atlas", label: "Atlas" }]);
  });

  it("drops machines with no server config", () => {
    expect(
      linkSourceOptions([
        {
          environmentId: "unknown",
          label: "Unknown",
          connection: { phase: "connected" },
          serverConfig: null,
        },
      ]),
    ).toEqual([]);
  });
});

describe("linkTargetOptions", () => {
  it("leaves out the source machine", () => {
    const machines = buildMeshMachines({
      config: {
        ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
        machines: { atlas: {}, lab: {} },
      },
    });
    expect(linkTargetOptions(machines, "atlas").map((machine) => machine.environmentId)).toEqual([
      "lab",
    ]);
    expect(linkTargetOptions(machines, null)).toHaveLength(2);
  });
});

describe("shouldOfferConnect", () => {
  const machines = buildMeshMachines({
    config: DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    connections: [
      { environmentId: "atlas", label: "Atlas", connected: true },
      { environmentId: "lab", label: "lab", connected: false, urls: ["https://lab.local"] },
      { environmentId: "vps", label: "VPS", connected: false },
    ],
  });

  it("offers a connection only when this app knows an address", () => {
    expect(shouldOfferConnect(machines.find((m) => m.environmentId === "lab")!)).toBe(true);
    expect(shouldOfferConnect(machines.find((m) => m.environmentId === "vps")!)).toBe(false);
    expect(shouldOfferConnect(machines.find((m) => m.environmentId === "atlas")!)).toBe(false);
  });
});

describe("meshSetupPrompt", () => {
  it("lists machines in plain words and leaves the goal to the user", () => {
    const prompt = meshSetupPrompt(
      [
        { label: "Studio", online: true },
        { label: "Cloudbox", online: false, detail: "Offline · 3 min" },
      ],
      ["Cloudbox is offline"],
    );
    expect(prompt).toContain("Machines: Studio (online), Cloudbox (Offline · 3 min).");
    expect(prompt).toContain("- Cloudbox is offline");
    expect(prompt).toContain("t3ctl mesh config plan");
    expect(prompt).not.toContain("environmentId");
  });
});

describe("meshProjectRows", () => {
  it("speaks about main copies, synced copies and unreachable copies without counts", () => {
    const config = {
      ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
      machines: { studio: { label: "Studio" } },
      projectTitles: { a: "Billing", b: "Deployment" },
      projectMounts: {
        a: [
          {
            environmentId: "studio",
            path: "/repo/billing",
            transport: "git" as const,
            role: "primary" as const,
            createdAt: "",
          },
          {
            environmentId: "cloudbox",
            path: "/copy/billing",
            transport: "mutagen" as const,
            role: "replica" as const,
            source: "studio",
            createdAt: "",
          },
        ],
        b: [
          {
            environmentId: "cloudbox",
            path: "/copy/deploy",
            transport: "mutagen" as const,
            role: "replica" as const,
            source: "studio",
            createdAt: "",
          },
        ],
      },
      projectMountStatus: {
        a: { cloudbox: { state: "watching" as const, updatedAt: "" } },
        b: { cloudbox: { state: "error" as const, updatedAt: "" } },
      },
    };
    expect(meshProjectRows(config, "studio")).toEqual([
      { key: "a", title: "Billing", sentence: "Billing · main copy", canRetry: false },
    ]);
    expect(meshProjectRows(config, "cloudbox")).toEqual([
      { key: "a", title: "Billing", sentence: "Billing · copy synced", canRetry: false },
      {
        key: "b",
        title: "Deployment",
        sentence: "Deployment · can't reach Studio",
        canRetry: true,
      },
    ]);
  });
});

describe("mesh problem helpers", () => {
  it("writes one plain offline sentence without repeating 'offline'", () => {
    expect(offlineMachinePrompt("Laptop", "offline 5 min").split("\n")[0]).toBe(
      "Laptop has been offline for 5 min.",
    );
    expect(offlineMachinePrompt("Laptop", "offline now").split("\n")[0]).toBe(
      "Laptop has just gone offline.",
    );
    expect(offlineMachinePrompt("Laptop", "Offline").split("\n")[0]).toBe(
      "Laptop has just gone offline.",
    );
  });

  it("strips error class names from failure text", () => {
    expect(
      plainFailureText({ message: "PeerLinkError: That pairing code is wrong or expired." }),
    ).toBe("That pairing code is wrong or expired.");
    expect(plainFailureText(new Error("NetworkError: offline"))).toBe("offline");
  });

  it("hides the link source picker on a single-machine client", () => {
    expect(showsLinkSourcePicker([{ environmentId: "a" }])).toBe(false);
    expect(showsLinkSourcePicker([{ environmentId: "a" }, { environmentId: "b" }])).toBe(true);
  });

  it("lists failed updates from the layout with an agent prompt", () => {
    const problems = meshUpdateProblems({
      "mesh.updateFailure/r7": {
        v: { environmentId: "cloudbox", reason: "health check failed", target: "0.1.7" },
      },
      "other/key": { v: { environmentId: "x", reason: "y" } },
    });
    expect(problems).toEqual([
      {
        revision: "r7",
        environmentId: "cloudbox",
        reason: "health check failed",
        target: "0.1.7",
      },
    ]);
    expect(meshUpdatePrompt(problems[0]!, "Cloudbox")).toContain(
      "The T3 update to 0.1.7 failed on Cloudbox.",
    );
  });
});
