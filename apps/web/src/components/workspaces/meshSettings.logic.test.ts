import { buildMeshMachines } from "@t3tools/client-runtime/state/mesh-machines";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { linkSourceOptions, linkTargetOptions, shouldOfferConnect } from "./meshSettings.logic";

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
        environment("gvidon", "Gvidon"),
        environment("gor", "gor", { connected: false }),
        environment("vps", "VPS", { peerLinks: false }),
        environment("old", "Old", { linkedEnvironmentsEnabled: false }),
      ]),
    ).toEqual([{ environmentId: "gvidon", label: "Gvidon" }]);
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
        machines: { gvidon: {}, gor: {} },
      },
    });
    expect(linkTargetOptions(machines, "gvidon").map((machine) => machine.environmentId)).toEqual([
      "gor",
    ]);
    expect(linkTargetOptions(machines, null)).toHaveLength(2);
  });
});

describe("shouldOfferConnect", () => {
  const machines = buildMeshMachines({
    config: DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    connections: [
      { environmentId: "gvidon", label: "Gvidon", connected: true },
      { environmentId: "gor", label: "gor", connected: false, urls: ["https://gor.local"] },
      { environmentId: "vps", label: "VPS", connected: false },
    ],
  });

  it("offers a connection only when this app knows an address", () => {
    expect(shouldOfferConnect(machines.find((m) => m.environmentId === "gor")!)).toBe(true);
    expect(shouldOfferConnect(machines.find((m) => m.environmentId === "vps")!)).toBe(false);
    expect(shouldOfferConnect(machines.find((m) => m.environmentId === "gvidon")!)).toBe(false);
  });
});
