import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMeshMachines,
  deriveMeshFooterStatus,
  machineReachOf,
  meshFooterText,
  meshMachineLastSync,
  setMachineReach,
} from "./meshMachines.ts";

const base: SidebarWorkspacesConfig = {
  ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  machines: {
    operatia: { label: "Operalia", tag: "OP", color: "#123456" },
  },
  projectMounts: {
    "project-a": [
      {
        environmentId: "operatia",
        path: "/srv/app",
        transport: "mutagen",
        role: "replica",
        source: "gvidon",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        environmentId: "gvidon",
        path: "/home/app",
        transport: "git",
        role: "primary",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
  projectMountStatus: {
    "project-a": {
      operatia: { state: "conflict", conflicts: 2, updatedAt: "2026-01-01T00:00:00.000Z" },
    },
  },
};

describe("buildMeshMachines", () => {
  it("unions connections, layout machines, representations, links and peers", () => {
    const machines = buildMeshMachines({
      config: base,
      connections: [
        { environmentId: "gvidon", label: "Gvidon", version: "0.1.5", connected: true },
        { environmentId: "gor", label: "gor", connected: false },
      ],
      links: [
        {
          environmentId: "gvidon",
          links: [
            { environmentId: "operatia", label: "Operalia", urls: ["https://op.example"] },
            { environmentId: "vps", label: "VPS" },
          ],
        },
      ],
      peerStates: [
        { environmentId: "operatia", lastExchangeAt: null, lastError: null, sentSeq: 0, receivedSeq: 0 },
        { environmentId: "vps", lastExchangeAt: null, lastError: "offline", sentSeq: 3, receivedSeq: 4 },
      ],
    });
    expect(machines.map((machine) => machine.environmentId)).toEqual([
      "gor",
      "gvidon",
      "operatia",
      "vps",
    ]);
    const operatia = machines.find((machine) => machine.environmentId === "operatia")!;
    expect(operatia).toMatchObject({
      label: "Operalia",
      tag: "OP",
      color: "#123456",
      connectedHere: false,
      version: null,
      replicas: 1,
      primaries: 0,
      conflicts: 2,
      urls: ["https://op.example"],
    });
    expect(operatia.linkedWith).toEqual([
      { environmentId: "gvidon", label: "Gvidon", tag: "GV" },
    ]);
    const gvidon = machines.find((machine) => machine.environmentId === "gvidon")!;
    expect(gvidon.connectedHere).toBe(true);
    expect(gvidon.version).toBe("0.1.5");
    expect(gvidon.primaries).toBe(1);
    expect(gvidon.conflicts).toBe(0);
  });

  it("merges the same peer's state from several servers", () => {
    const machines = buildMeshMachines({
      config: base,
      peerStates: [
        {
          environmentId: "operatia",
          lastExchangeAt: "2026-01-01T00:00:00.000Z",
          lastError: null,
          sentSeq: 1,
          receivedSeq: 2,
        },
        {
          environmentId: "operatia",
          lastExchangeAt: "2026-01-01T00:02:00.000Z",
          lastError: null,
          sentSeq: 3,
          receivedSeq: 2,
        },
      ],
    });
    expect(machines.find((machine) => machine.environmentId === "operatia")).toMatchObject({
      lastExchangeAt: "2026-01-01T00:02:00.000Z",
      sentSeq: 3,
      receivedSeq: 2,
      lastError: null,
    });
  });

  it("counts a conflict state without an explicit count as one conflict", () => {
    const config: SidebarWorkspacesConfig = {
      ...base,
      projectMountStatus: {
        "project-a": {
          operatia: { state: "conflict", updatedAt: "2026-01-01T00:00:00.000Z" },
        },
      },
    };
    const operatia = buildMeshMachines({ config }).find(
      (machine) => machine.environmentId === "operatia",
    )!;
    expect(operatia.conflicts).toBe(1);
  });
});

describe("deriveMeshFooterStatus", () => {
  const machines = buildMeshMachines({
    config: base,
    connections: [{ environmentId: "gvidon", label: "Gvidon", connected: true }],
    peerStates: [
      {
        environmentId: "operatia",
        lastExchangeAt: "2026-01-01T00:00:00.000Z",
        lastError: null,
        sentSeq: 0,
        receivedSeq: 0,
      },
    ],
  });

  it("is hidden when the mesh is off or nothing is known", () => {
    expect(deriveMeshFooterStatus({ enabled: false, machines, now: 0 })).toEqual({
      kind: "hidden",
    });
    expect(deriveMeshFooterStatus({ enabled: true, machines: [], now: 0 })).toEqual({
      kind: "hidden",
    });
    expect(meshFooterText({ kind: "hidden" })).toBeNull();
  });

  it("says how many machines sync when none reports an error", () => {
    const status = deriveMeshFooterStatus({ enabled: true, machines, now: 0 });
    expect(status).toEqual({ kind: "synced", count: 2 });
    expect(meshFooterText(status)).toBe("Mesh · 2 machines · synced");
  });

  it("names the first failing machine and how long it has been failing", () => {
    const failing = buildMeshMachines({
      config: base,
      connections: [{ environmentId: "gvidon", label: "Gvidon", connected: true }],
      peerStates: [
        {
          environmentId: "operatia",
          lastExchangeAt: "2026-01-01T00:00:00.000Z",
          lastError: "unreachable",
          sentSeq: 0,
          receivedSeq: 0,
        },
      ],
    });
    const status = deriveMeshFooterStatus({
      enabled: true,
      machines: failing,
      now: Date.parse("2026-01-01T00:05:00.000Z"),
    });
    expect(status).toEqual({
      kind: "unreachable",
      count: 2,
      environmentId: "operatia",
      label: "Operalia",
      tag: "OP",
      minutes: 5,
    });
    expect(meshFooterText(status)).toBe("Mesh · OP unreachable for 5 min");
  });
});

describe("meshMachineLastSync", () => {
  const machine = buildMeshMachines({
    config: base,
    peerStates: [
      {
        environmentId: "operatia",
        lastExchangeAt: "2026-01-01T00:00:00.000Z",
        lastError: null,
        sentSeq: 0,
        receivedSeq: 0,
      },
    ],
  }).find((entry) => entry.environmentId === "operatia")!;

  it("describes minutes and hours since the last exchange", () => {
    expect(meshMachineLastSync(machine, Date.parse("2026-01-01T00:00:30.000Z"))).toBe(
      "Synced just now",
    );
    expect(meshMachineLastSync(machine, Date.parse("2026-01-01T00:07:00.000Z"))).toBe(
      "Synced 7 min ago",
    );
    expect(meshMachineLastSync(machine, Date.parse("2026-01-01T03:00:00.000Z"))).toBe(
      "Synced 3 h ago",
    );
  });

  it("says never when the server has not recorded an exchange", () => {
    const other = { ...machine, lastExchangeAt: null };
    expect(meshMachineLastSync(other, 0)).toBe("Never synced");
  });
});

describe("ssh routes", () => {
  it("saves a destination and identity file under the source machine", () => {
    const next = setMachineReach(base, "operatia", "gvidon", {
      ssh: "gvidon",
      identityFile: "~/.ssh/id_ed25519",
    });
    expect(machineReachOf(next, "operatia", "gvidon")).toEqual({
      ssh: "gvidon",
      identityFile: "~/.ssh/id_ed25519",
    });
    expect(machineReachOf(base, "operatia", "gvidon")).toBeNull();
  });

  it("drops the identity file when empty and removes a route with an empty destination", () => {
    const withFile = setMachineReach(base, "operatia", "gvidon", {
      ssh: " gvidon ",
      identityFile: "  ",
    });
    expect(machineReachOf(withFile, "operatia", "gvidon")).toEqual({ ssh: "gvidon" });
    const removed = setMachineReach(withFile, "operatia", "gvidon", { ssh: "   " });
    expect(machineReachOf(removed, "operatia", "gvidon")).toBeNull();
    expect(removed.machines.operatia).toEqual({ label: "Operalia", tag: "OP", color: "#123456" });
  });
});
