import type {
  EnvironmentId,
  MeshLayoutSnapshot as RpcMeshLayoutSnapshot,
  SidebarWorkspace,
  SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { materialize, merge, type MeshLayoutDocument } from "@t3tools/shared/meshLayout";
import { describe, expect, it } from "vite-plus/test";

import { machineTag, mergeSuggestionsFor, offlineLogicalProjects } from "./meshLayout/index.ts";
import { addWorkspace } from "./sidebarWorkspaces.ts";
import {
  MeshLayoutClient,
  acknowledgeMeshLayoutEntries,
  editMeshLayout,
  emptyMeshLayoutState,
  isPermanentMeshLayoutFailure,
  mergeMeshLayoutSnapshot,
  parseMeshLayoutCache,
  pickMeshSource,
  serializeMeshLayoutCache,
  type MeshLayoutClientState,
  type MeshLayoutPersistencePort,
  type MeshLayoutRpcPort,
  type MeshLayoutSnapshot,
  type MeshLayoutSourceEnvironment,
} from "./meshLayoutClient.ts";

const env = (id: string): EnvironmentId => id as EnvironmentId;

function source(
  id: string,
  options: { connected?: boolean; mesh?: boolean } = {},
): MeshLayoutSourceEnvironment {
  return {
    environmentId: env(id),
    connected: options.connected ?? true,
    capabilities: { meshLayout: options.mesh ?? true },
  };
}

const base = materialize({
  "ws/a": { v: { name: "A", sort: "a" }, h: "0000000000001.00000.seed" },
  "ws.default": { v: "a", h: "0000000000001.00000.seed" },
});

function snapshotOf(id: string, document: MeshLayoutDocument): MeshLayoutSnapshot {
  return { environmentId: env(id), document, config: materialize(document) };
}

class FakeRpc implements MeshLayoutRpcPort {
  readonly applies: Array<{ environmentId: string; entries: MeshLayoutDocument }> = [];
  readonly documents = new Map<string, MeshLayoutDocument>();
  readonly subscriptions: string[] = [];
  private readonly listeners = new Map<string, (snapshot: RpcMeshLayoutSnapshot) => void>();
  private readonly failures = new Map<string, (error: unknown) => void>();
  applyError: unknown = null;

  constructor(initial: Record<string, MeshLayoutDocument> = {}) {
    for (const [id, document] of Object.entries(initial)) this.documents.set(id, document);
  }

  async get(environmentId: EnvironmentId): Promise<RpcMeshLayoutSnapshot> {
    return snapshotOf(environmentId, this.documents.get(environmentId) ?? {});
  }

  async apply(
    environmentId: EnvironmentId,
    entries: MeshLayoutDocument,
  ): Promise<RpcMeshLayoutSnapshot> {
    this.applies.push({ environmentId, entries });
    if (this.applyError !== null) throw this.applyError;
    const document = merge(this.documents.get(environmentId) ?? {}, entries);
    this.documents.set(environmentId, document);
    const snapshot = snapshotOf(environmentId, document);
    this.listeners.get(environmentId)?.(snapshot);
    return snapshot;
  }

  subscribe(
    environmentId: EnvironmentId,
    onSnapshot: (snapshot: RpcMeshLayoutSnapshot) => void,
    onFailure?: (error: unknown) => void,
  ): () => void {
    this.subscriptions.push(environmentId);
    this.listeners.set(environmentId, onSnapshot);
    if (onFailure) this.failures.set(environmentId, onFailure);
    return () => {
      this.listeners.delete(environmentId);
      this.failures.delete(environmentId);
    };
  }

  fail(environmentId: EnvironmentId, error: unknown): void {
    this.failures.get(environmentId)?.(error);
  }

  push(environmentId: EnvironmentId, document: MeshLayoutDocument): void {
    this.documents.set(environmentId, document);
    this.listeners.get(environmentId)?.(snapshotOf(environmentId, document));
  }
}

function memoryPersistence(initial: MeshLayoutClientState | null = null) {
  let state = initial;
  const port: MeshLayoutPersistencePort & { readonly saved: () => MeshLayoutClientState | null } = {
    load: async () => state,
    save: async (next) => {
      state = next;
    },
    saved: () => state,
  };
  return port;
}

function client(rpc: FakeRpc, environments: ReadonlyArray<MeshLayoutSourceEnvironment>) {
  const persistence = memoryPersistence();
  const changes: MeshLayoutClientState[] = [];
  const failures: unknown[] = [];
  const mesh = new MeshLayoutClient({
    rpc,
    persistence,
    environments: () => environments,
    primaryEnvironmentId: () => env("primary"),
    deviceId: "device-1",
    now: () => 1000,
    onChange: (state) => changes.push(state),
    onPermanentFailure: (error) => failures.push(error),
  });
  return { mesh, persistence, changes, failures };
}

describe("pickMeshSource", () => {
  it("returns null when no connected server supports the mesh (legacy mode)", () => {
    expect(pickMeshSource([source("a", { mesh: false })], null)).toBeNull();
    expect(pickMeshSource([source("a", { connected: false })], null)).toBeNull();
    expect(pickMeshSource([], env("a"))).toBeNull();
  });

  it("prefers the primary environment, else the first capable id", () => {
    expect(pickMeshSource([source("b"), source("a")], env("b"))).toBe(env("b"));
    expect(pickMeshSource([source("b"), source("a")], null)).toBe(env("a"));
    expect(pickMeshSource([source("b"), source("a")], env("missing"))).toBe(env("a"));
  });
});

describe("mesh layout cache and optimistic edits", () => {
  it("round-trips the cache and ignores corrupt data", () => {
    const state = editMeshLayout(emptyMeshLayoutState(), () => base, {
      deviceId: "d",
      now: 1,
    }).state;
    expect(state.snapshot).toBeNull();
    const populated = mergeMeshLayoutSnapshot(emptyMeshLayoutState(), snapshotOf("a", {}));
    expect(parseMeshLayoutCache(serializeMeshLayoutCache(populated))?.snapshot?.config).toEqual(
      populated.snapshot?.config,
    );
    expect(parseMeshLayoutCache("{nope")).toBeNull();
    expect(parseMeshLayoutCache(null)).toBeNull();
  });

  it("applies an edit optimistically and clears it when the server echoes it", async () => {
    const rpc = new FakeRpc({ primary: {} });
    const { mesh, persistence } = client(rpc, [source("primary")]);
    await mesh.start();
    const entries = await mesh.edit((config) => addWorkspace(config).config);
    expect(Object.keys(entries).length).toBeGreaterThan(0);
    expect(mesh.current.snapshot?.config.workspaces).toHaveLength(1);
    expect(mesh.current.outbox).toEqual({});
    expect(rpc.applies).toHaveLength(1);
    expect(persistence.saved()?.outbox).toEqual({});
  });

  it("keeps a transient failure queued and replays it", async () => {
    const rpc = new FakeRpc({ primary: {} });
    const { mesh, persistence } = client(rpc, [source("primary")]);
    await mesh.start();
    rpc.applyError = new Error("offline");
    await mesh.edit((config) => addWorkspace(config).config);
    expect(Object.keys(mesh.current.outbox)).not.toHaveLength(0);
    expect(persistence.saved()?.outbox).not.toEqual({});
    rpc.applyError = null;
    await mesh.replayOutbox();
    expect(mesh.current.outbox).toEqual({});
    expect(mesh.current.snapshot?.config.workspaces).toHaveLength(1);
  });

  it("drops entries the incoming snapshot already contains", () => {
    const withEntry = editMeshLayout(
      mergeMeshLayoutSnapshot(emptyMeshLayoutState(), snapshotOf("a", {})),
      (config) => addWorkspace(config).config,
      { deviceId: "d", now: 2 },
    ).state;
    expect(Object.keys(withEntry.outbox)).not.toHaveLength(0);
    const merged = mergeMeshLayoutSnapshot(
      withEntry,
      snapshotOf("a", withEntry.snapshot!.document),
    );
    expect(merged.outbox).toEqual({});
  });

  it("acknowledges only the exact entries it sent", () => {
    const state = editMeshLayout(
      mergeMeshLayoutSnapshot(emptyMeshLayoutState(), snapshotOf("a", {})),
      (config) => addWorkspace(config).config,
      { deviceId: "d", now: 2 },
    ).state;
    expect(acknowledgeMeshLayoutEntries(state, {}).outbox).toEqual(state.outbox);
  });

  it("clears a permanently failed edit and reports it", async () => {
    const rpc = new FakeRpc({ primary: {} });
    const { mesh, failures } = client(rpc, [source("primary")]);
    await mesh.start();
    rpc.applyError = { _tag: "MeshLayoutError", reason: "invalid_entries" };
    await mesh.edit((config) => addWorkspace(config).config);
    expect(mesh.current.outbox).toEqual({});
    expect(failures).toHaveLength(1);
    expect(isPermanentMeshLayoutFailure(rpc.applyError)).toBe(true);
    expect(isPermanentMeshLayoutFailure(new Error("offline"))).toBe(false);
  });
});

describe("MeshLayoutClient sources", () => {
  it("loads the cached snapshot before a server answers", async () => {
    const cached: MeshLayoutClientState = mergeMeshLayoutSnapshot(
      emptyMeshLayoutState(),
      snapshotOf("primary", {
        "ws/a": { v: { name: "Cached", sort: "a" }, h: "0000000000001.00000.seed" },
      }),
    );
    const rpc = new FakeRpc();
    let release: (() => void) | null = null;
    rpc.get = () =>
      new Promise((resolve) => {
        release = () => resolve(snapshotOf("primary", {}));
      });
    const persistence = memoryPersistence(cached);
    const changes: MeshLayoutClientState[] = [];
    const mesh = new MeshLayoutClient({
      rpc,
      persistence,
      environments: () => [source("primary")],
      primaryEnvironmentId: () => null,
      deviceId: "d",
      now: () => 1,
      onChange: (state) => changes.push(state),
    });
    const started = mesh.start();
    await Promise.resolve();
    expect(changes.at(-1)?.snapshot?.config.workspaces[0]?.name).toBe("Cached");
    release!();
    await started;
  });

  it("fails over to another source when the first disconnects", async () => {
    const rpc = new FakeRpc({
      primary: {},
      secondary: { "ws/b": { v: { name: "Secondary", sort: "a" }, h: "0000000000001.00000.seed" } },
    });
    const environments = [source("primary"), source("secondary")];
    const { mesh } = client(rpc, environments);
    await mesh.start();
    expect(rpc.subscriptions).toEqual(["primary"]);
    rpc.fail(env("primary"), new Error("disconnected"));
    await Promise.resolve();
    await Promise.resolve();
    expect(rpc.subscriptions).toEqual(["primary", "secondary"]);
    expect(mesh.sourceEnvironmentId).toBe(env("secondary"));
    expect(mesh.current.snapshot?.config.workspaces[0]?.name).toBe("Secondary");
  });

  it("stays in legacy mode when no server supports the mesh", async () => {
    const rpc = new FakeRpc();
    const { mesh } = client(rpc, [source("primary", { mesh: false })]);
    await mesh.start();
    expect(mesh.sourceEnvironmentId).toBeNull();
    expect(mesh.current.snapshot).toBeNull();
    expect(rpc.subscriptions).toEqual([]);
  });
});

describe("workspace config helpers", () => {
  it("materializes the workspace added by the shared helper", () => {
    const config = addWorkspace(base).config;
    const workspace = config.workspaces.at(-1) as SidebarWorkspace;
    expect(workspace.name).toBe("Workspace 2");
    expect(materialize({}).workspaces).toEqual([]);
  });
});

describe("logical project helpers", () => {
  const config: SidebarWorkspacesConfig = {
    ...base,
    machines: { "env-b": { tag: "BO" } },
    projectMounts: {
      "logical-a": [
        {
          environmentId: "env-a",
          path: "/repos/a",
          transport: "git",
          role: "primary",
          createdAt: "",
        },
      ],
      "logical-b": [
        {
          environmentId: "env-b",
          path: "/repos/b",
          transport: "git",
          role: "primary",
          createdAt: "",
        },
      ],
      "logical-c": [
        {
          environmentId: "env-a",
          path: "/repos/c",
          transport: "git",
          role: "primary",
          createdAt: "",
        },
        {
          environmentId: "env-b",
          path: "/repos/c",
          transport: "mutagen",
          role: "replica",
          source: "env-a",
          createdAt: "",
        },
      ],
    },
    projectMountStatus: {
      "logical-b": {
        "env-b": { state: "watching" as const, updatedAt: "2026-01-02T00:00:00.000Z" },
      },
    },
  };

  it("derives machine tags from the layout or the label", () => {
    expect(machineTag(config, "env-b")).toBe("BO");
    expect(machineTag(config, "env-z", "Boreal")).toBe("BO");
    expect(machineTag(config, "env-z")).toBe("EN");
    expect(machineTag(config, "env-z", "lab")).toBe("LAB");
    expect(
      machineTag({ ...config, machines: { "env-z": { label: "vps" } } }, "env-z", "server name"),
    ).toBe("VPS");
  });

  it("lists a project only when every representation is unreachable", () => {
    const offline = offlineLogicalProjects(config, new Set(["env-a"]));
    expect(offline.map((entry) => entry.logicalKey)).toEqual(["logical-b"]);
    expect(offline[0]).toMatchObject({ environmentId: "env-b", state: "watching", tag: "BO" });
  });

  it("suggests a merge by title across machines", () => {
    const projects = [
      { environmentId: "env-a", workspaceRoot: "/repos/x", title: "X" },
      { environmentId: "env-b", workspaceRoot: "/repos/x2", title: "x" },
      { environmentId: "env-b", workspaceRoot: "/repos/y", title: "Y" },
    ];
    const suggestions = mergeSuggestionsFor(
      config,
      projects,
      "env-a:x",
      (project) => `${project.environmentId}:${project.title.toLowerCase()}`,
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ tag: "BO" });
    expect(suggestions[0]?.project.environmentId).toBe("env-b");
  });
});
