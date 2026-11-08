import { buildMeshMachines } from "@t3tools/client-runtime/state/mesh-machines";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  linkSourceOptions,
  linkTargetOptions,
  meshSetupPrompt,
  shouldOfferConnect,
} from "./meshSettings.logic";

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
