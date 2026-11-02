import { buildMeshMachines } from "@t3tools/client-runtime/state/mesh-machines";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  meshLinkSourceOptions,
  meshLinkTargets,
  meshSwitchValue,
  meshTogglePatch,
} from "./mesh-settings.logic";

describe("meshSwitchValue", () => {
  it("is on only when both flags are on", () => {
    expect(meshSwitchValue({ linkedEnvironmentsEnabled: true, meshEnabled: true })).toBe(true);
    expect(meshSwitchValue({ linkedEnvironmentsEnabled: true, meshEnabled: false })).toBe(false);
    expect(meshSwitchValue({})).toBe(false);
  });
});

describe("meshTogglePatch", () => {
  it("writes both flags together", () => {
    expect(meshTogglePatch(true)).toEqual({
      linkedEnvironmentsEnabled: true,
      meshEnabled: true,
    });
    expect(meshTogglePatch(false)).toEqual({
      linkedEnvironmentsEnabled: false,
      meshEnabled: false,
    });
  });
});

describe("meshLinkSourceOptions", () => {
  it("keeps connected machines with links enabled", () => {
    expect(
      meshLinkSourceOptions([
        {
          environmentId: "gvidon",
          label: "Gvidon",
          connection: { phase: "connected" },
          serverConfig: {
            settings: { linkedEnvironmentsEnabled: true },
            environment: { capabilities: { peerLinks: true } },
          },
        },
        {
          environmentId: "gor",
          label: "gor",
          connection: { phase: "offline" },
          serverConfig: {
            settings: { linkedEnvironmentsEnabled: true },
            environment: { capabilities: { peerLinks: true } },
          },
        },
      ]),
    ).toEqual([{ environmentId: "gvidon", label: "Gvidon" }]);
  });
});

describe("meshLinkTargets", () => {
  it("leaves out the source", () => {
    const machines = buildMeshMachines({
      config: {
        ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
        machines: { gvidon: {}, gor: {} },
      },
    });
    expect(meshLinkTargets(machines, "gvidon").map((m) => m.environmentId)).toEqual(["gor"]);
  });
});
