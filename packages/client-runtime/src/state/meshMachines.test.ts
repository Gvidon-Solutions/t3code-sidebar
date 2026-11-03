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
    boreal: { label: "Boreal", tag: "BO", color: "#123456", aliases: ["studio", "研究室"] },
  },
  projectMounts: {
    "project-a": [
      {
        environmentId: "boreal",
        path: "/srv/app",
        transport: "mutagen",
        role: "replica",
        source: "atlas",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        environmentId: "atlas",
        path: "/home/app",
        transport: "git",
        role: "primary",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
  projectMountStatus: {
    "project-a": {
      boreal: { state: "conflict", conflicts: 2, updatedAt: "2026-01-01T00:00:00.000Z" },
    },
  },
};

describe("buildMeshMachines", () => {
  it("unions connections, layout machines, representations, links and peers", () => {
    const machines = buildMeshMachines({
      config: base,
      connections: [
        { environmentId: "atlas", label: "Atlas", version: "0.1.5", connected: true },
        { environmentId: "lab", label: "lab", connected: false },
      ],
      links: [
        {
          environmentId: "atlas",
          links: [
            { environmentId: "boreal", label: "Boreal", urls: ["https://bo.example"] },
            { environmentId: "vps", label: "VPS" },
          ],
        },
      ],
      peerStates: [
        {
          environmentId: "boreal",
          lastExchangeAt: null,
          lastError: null,
          sentSeq: 0,
          receivedSeq: 0,
        },
        {
          environmentId: "vps",
          lastExchangeAt: null,
          lastError: "offline",
          sentSeq: 3,
          receivedSeq: 4,
        },
      ],
    });
    expect(machines.map((machine) => machine.environmentId)).toEqual([
      "atlas",
      "boreal",
      "lab",
      "vps",
    ]);
    const boreal = machines.find((machine) => machine.environmentId === "boreal")!;
    expect(boreal).toMatchObject({
      label: "Boreal",
      tag: "BO",
      color: "#123456",
      aliases: ["studio", "研究室"],
      connectedHere: false,
      version: null,
      replicas: 1,
      primaries: 0,
      conflicts: 2,
      urls: ["https://bo.example"],
    });
    expect(
      machines
        .find((machine) => machine.environmentId === "atlas")
        ?.linkedWith.map((peer) => peer.environmentId),
    ).toContain("boreal");
    expect(boreal.linkedWith).toEqual([{ environmentId: "atlas", label: "Atlas", tag: "AT" }]);
    const atlas = machines.find((machine) => machine.environmentId === "atlas")!;
    expect(atlas.connectedHere).toBe(true);
    expect(atlas.version).toBe("0.1.5");
    expect(atlas.primaries).toBe(1);
    expect(atlas.conflicts).toBe(0);
  });

  it("merges the same peer's state from several servers", () => {
    const machines = buildMeshMachines({
      config: base,
      peerStates: [
        {
          environmentId: "boreal",
          lastExchangeAt: "2026-01-01T00:00:00.000Z",
          lastError: null,
          sentSeq: 1,
          receivedSeq: 2,
        },
        {
          environmentId: "boreal",
          lastExchangeAt: "2026-01-01T00:02:00.000Z",
          lastError: null,
          sentSeq: 3,
          receivedSeq: 2,
        },
      ],
    });
    expect(machines.find((machine) => machine.environmentId === "boreal")).toMatchObject({
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
          boreal: { state: "conflict", updatedAt: "2026-01-01T00:00:00.000Z" },
        },
      },
    };
    const boreal = buildMeshMachines({ config }).find(
      (machine) => machine.environmentId === "boreal",
    )!;
    expect(boreal.conflicts).toBe(1);
  });
});

describe("deriveMeshFooterStatus", () => {
  const machines = buildMeshMachines({
    config: base,
    connections: [{ environmentId: "atlas", label: "Atlas", connected: true }],
    peerStates: [
      {
        environmentId: "boreal",
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
      connections: [{ environmentId: "atlas", label: "Atlas", connected: true }],
      peerStates: [
        {
          environmentId: "boreal",
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
      environmentId: "boreal",
      label: "Boreal",
      tag: "BO",
      minutes: 5,
    });
    expect(meshFooterText(status)).toBe("Mesh · BO unreachable for 5 min");
  });
});

describe("meshMachineLastSync", () => {
  const machine = buildMeshMachines({
    config: base,
    peerStates: [
      {
        environmentId: "boreal",
        lastExchangeAt: "2026-01-01T00:00:00.000Z",
        lastError: null,
        sentSeq: 0,
        receivedSeq: 0,
      },
    ],
  }).find((entry) => entry.environmentId === "boreal")!;

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
    const next = setMachineReach(base, "boreal", "atlas", {
      ssh: "atlas",
      identityFile: "~/.ssh/id_ed25519",
    });
    expect(machineReachOf(next, "boreal", "atlas")).toEqual({
      ssh: "atlas",
      identityFile: "~/.ssh/id_ed25519",
    });
    expect(machineReachOf(base, "boreal", "atlas")).toBeNull();
  });

  it("drops the identity file when empty and removes a route with an empty destination", () => {
    const withFile = setMachineReach(base, "boreal", "atlas", {
      ssh: " atlas ",
      identityFile: "  ",
    });
    expect(machineReachOf(withFile, "boreal", "atlas")).toEqual({ ssh: "atlas" });
    const removed = setMachineReach(withFile, "boreal", "atlas", { ssh: "   " });
    expect(machineReachOf(removed, "boreal", "atlas")).toBeNull();
    expect(removed.machines.boreal).toEqual(base.machines.boreal);
  });
});

it("mints on the target before linking from the source, and supports manual codes", async () => {
  const { linkMeshMachines } = await import("./meshMachines.ts");
  const { EnvironmentId } = await import("@t3tools/contracts");
  const source = EnvironmentId.make("source");
  const target = { environmentId: EnvironmentId.make("target"), label: "Target" };
  const calls: unknown[] = [];
  const mintCode = async (id: string) => {
    calls.push(["mint", id]);
    return "fresh-code";
  };
  const link = async (id: string, request: unknown) => {
    calls.push(["link", id, request]);
    return "linked";
  };
  expect(
    await linkMeshMachines({
      source,
      target,
      url: " https://target ",
      code: "",
      mintOnTarget: true,
      mintCode,
      link,
    }),
  ).toBe("linked");
  expect(calls).toEqual([
    ["mint", "target"],
    [
      "link",
      "source",
      {
        url: "https://target",
        pairingCode: "fresh-code",
        access: "full-access",
        expectedEnvironmentId: "target",
        expectedLabel: "Target",
      },
    ],
  ]);
  calls.length = 0;
  await linkMeshMachines({
    source,
    target: null,
    url: "https://unknown",
    code: " manual ",
    mintOnTarget: false,
    mintCode,
    link,
  });
  expect(calls).toEqual([
    ["link", "source", { url: "https://unknown", pairingCode: "manual", access: "full-access" }],
  ]);
  calls.length = 0;
  await expect(
    linkMeshMachines({
      source,
      target,
      url: "https://target",
      code: "",
      mintOnTarget: true,
      mintCode: async () => {
        throw new Error("denied");
      },
      link,
    }),
  ).rejects.toThrow("denied");
  expect(calls).toEqual([]);
  await expect(
    linkMeshMachines({
      source,
      target: { ...target, environmentId: source },
      url: "https://target",
      code: "manual",
      mintOnTarget: false,
      mintCode,
      link,
    }),
  ).rejects.toThrow("Choose another machine");
  await expect(
    linkMeshMachines({
      source,
      target,
      url: " ",
      code: "manual",
      mintOnTarget: false,
      mintCode,
      link,
    }),
  ).rejects.toThrow("address");
  await expect(
    linkMeshMachines({
      source,
      target: null,
      url: "https://target",
      code: " ",
      mintOnTarget: false,
      mintCode,
      link,
    }),
  ).rejects.toThrow("pairing code");
});
