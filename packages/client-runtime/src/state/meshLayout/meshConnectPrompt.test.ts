import { describe, expect, it } from "vite-plus/test";
import {
  dismissMeshConnectPrompt,
  planMeshConnect,
  shouldShowMeshConnectPrompt,
} from "./meshConnectPrompt.ts";

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

  it("ignores a saved connection that is already enabled", () => {
    expect(
      planMeshConnect({
        machines,
        connectedEnvironmentIds: new Set(["studio", "laptop"]),
        entries: new Map([["cloudbox", { enabled: true }]]),
      }),
    ).toEqual({ reconnect: [], missing: [], needed: false });
  });

  it("keeps a new machine's prompt after an earlier dismissal", () => {
    const first = planMeshConnect({
      machines,
      connectedEnvironmentIds: new Set(["studio", "cloudbox"]),
      entries: new Map([["laptop", { enabled: false }]]),
    });
    const dismissed = dismissMeshConnectPrompt([], first);
    expect(shouldShowMeshConnectPrompt(first, dismissed)).toBe(false);
    const joined = planMeshConnect({
      machines: [...machines, { environmentId: "atlas", label: "atlas" }],
      connectedEnvironmentIds: new Set(["studio", "cloudbox"]),
      entries: new Map([["laptop", { enabled: false }]]),
    });
    expect(shouldShowMeshConnectPrompt(joined, dismissed)).toBe(true);
    expect(dismissMeshConnectPrompt(dismissed, joined)).toEqual(["atlas", "laptop"]);
    expect(shouldShowMeshConnectPrompt({ reconnect: [], missing: [], needed: false }, [])).toBe(
      false,
    );
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
