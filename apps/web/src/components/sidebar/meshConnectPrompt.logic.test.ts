import { describe, expect, it } from "vite-plus/test";
import { planMeshConnect } from "./meshConnectPrompt.logic";

const machines = [
  { environmentId: "studio", label: "studio" },
  { environmentId: "cloudbox", label: "cloudbox" },
  { environmentId: "laptop", label: "laptop" },
];

describe("planMeshConnect", () => {
  it("asks only when a mesh machine is not connected to this device", () => {
    expect(
      planMeshConnect({
        machines,
        connectedEnvironmentIds: new Set(["studio", "cloudbox", "laptop"]),
        entries: new Map(),
      }).needed,
    ).toBe(false);
  });

  it("reconnects saved environments and names machines that were never added", () => {
    expect(
      planMeshConnect({
        machines,
        connectedEnvironmentIds: new Set(["studio"]),
        entries: new Map([["cloudbox", { enabled: false }]]),
      }),
    ).toEqual({
      reconnect: [{ environmentId: "cloudbox", label: "cloudbox" }],
      missing: [{ environmentId: "laptop", label: "laptop" }],
      needed: true,
    });
  });
});
