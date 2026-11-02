import {
  MESH_WS_METHODS,
  MeshLayoutEntries,
  SidebarWorkspacesConfig,
  type EnvironmentId,
  type MeshLayoutSnapshot as RpcMeshLayoutSnapshot,
  type SidebarWorkspacesConfig as SidebarWorkspacesConfigType,
} from "@t3tools/contracts";
import {
  diff,
  materialize,
  merge,
  tick,
  type Hlc,
  type MeshLayoutDocument,
} from "@t3tools/shared/meshLayout";
import * as Schema from "effect/Schema";
import type { Atom } from "effect/reactivity";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
/**
 * T3 Mesh (fork): client-side layout sync. The document is the source of truth; the materialized
 * config is what the existing sidebar functions and UI read. Offline edits live in an outbox of
 * idempotent entries and are replayed when a mesh-capable server is connected again.
 */
export interface MeshLayoutSnapshot {
  readonly environmentId: string;
  readonly document: MeshLayoutDocument;
  readonly config: SidebarWorkspacesConfigType;
}

export interface MeshLayoutSourceEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly capabilities?: { readonly meshLayout?: boolean } | null | undefined;
}

/**
 * `null` means legacy mode: no connected server advertises `meshLayout`, so the sidebar keeps
 * reading and writing `sidebarWorkspaces` through `SHARED_SERVER_SETTING_KEYS` as before.
 */
export function pickMeshSource(
  environments: ReadonlyArray<MeshLayoutSourceEnvironment>,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  const capable = environments
    .filter((environment) => environment.connected && environment.capabilities?.meshLayout === true)
    .map((environment) => environment.environmentId)
    .sort();
  if (capable.length === 0) return null;
  if (primaryEnvironmentId !== null && capable.includes(primaryEnvironmentId)) {
    return primaryEnvironmentId;
  }
  return capable[0]!;
}

export interface MeshLayoutClientState {
  /** Last snapshot shown, including optimistic local edits; also the offline cache. */
  readonly snapshot: MeshLayoutSnapshot | null;
  /** Local entries not yet reflected by a server snapshot. */
  readonly outbox: MeshLayoutDocument;
  /** Latest clock this device saw, so local edits sort after everything it knows. */
  readonly clock: Hlc | null;
}

export function emptyMeshLayoutState(): MeshLayoutClientState {
  return { snapshot: null, outbox: {}, clock: null };
}

const MeshLayoutCacheSchema = Schema.Struct({
  snapshot: Schema.NullOr(
    Schema.Struct({
      environmentId: Schema.optionalKey(Schema.String),
      document: MeshLayoutEntries,
      config: SidebarWorkspacesConfig,
    }),
  ),
  outbox: MeshLayoutEntries,
  clock: Schema.NullOr(Schema.String),
});

const decodeCache = Schema.decodeUnknownSync(Schema.fromJsonString(MeshLayoutCacheSchema));
const encodeCache = Schema.encodeSync(Schema.fromJsonString(MeshLayoutCacheSchema));

/** Decodes a persisted cache, returning `null` for missing or corrupt data instead of throwing. */
export function parseMeshLayoutCache(json: string | null): MeshLayoutClientState | null {
  if (json === null || json.trim() === "") return null;
  try {
    const parsed = decodeCache(json);
    return {
      snapshot: parsed.snapshot
        ? {
            environmentId: parsed.snapshot.environmentId ?? "",
            document: parsed.snapshot.document as MeshLayoutDocument,
            config: parsed.snapshot.config,
          }
        : null,
      outbox: parsed.outbox as MeshLayoutDocument,
      clock: parsed.clock,
    };
  } catch {
    return null;
  }
}

export function serializeMeshLayoutCache(state: MeshLayoutClientState): string {
  return encodeCache(state);
}

interface EditResult {
  readonly state: MeshLayoutClientState;
  readonly entries: MeshLayoutDocument;
}

/** Applies an edit locally and returns the entries to send. Never mutates `state`. */
export function editMeshLayout(
  state: MeshLayoutClientState,
  update: (config: SidebarWorkspacesConfigType) => SidebarWorkspacesConfigType,
  input: { readonly deviceId: string; readonly now: number },
): EditResult {
  if (state.snapshot === null) return { state, entries: {} };
  const before = state.snapshot.config;
  const after = update(before);
  const hlc = tick(input.now, state.clock, input.deviceId);
  const entries = diff(before, after, state.snapshot.document, hlc);
  if (Object.keys(entries).length === 0) return { state, entries };
  const document = merge(state.snapshot.document, entries);
  return {
    state: {
      snapshot: {
        ...state.snapshot,
        document,
        config: materialize(document),
      },
      outbox: merge(state.outbox, entries),
      clock: hlc,
    },
    entries,
  };
}

/** Entries the server has not echoed yet. */
export function pendingMeshLayoutEntries(state: MeshLayoutClientState): MeshLayoutDocument {
  return state.outbox;
}

function highestHlc(hlcs: ReadonlyArray<Hlc | null | undefined>, fallback: Hlc | null): Hlc | null {
  let highest = fallback;
  for (const hlc of hlcs) {
    if (hlc !== null && hlc !== undefined && (highest === null || hlc > highest)) highest = hlc;
  }
  return highest;
}

/**
 * Merges a server snapshot with the local cache and drops outbox entries it already contains
 * (same key, clock at least as new). An echo of our own edit therefore clears the outbox without
 * being applied twice.
 */
export function mergeMeshLayoutSnapshot(
  state: MeshLayoutClientState,
  remote: MeshLayoutSnapshot,
  _now: number = 0,
): MeshLayoutClientState {
  const document = merge(state.snapshot?.document ?? {}, remote.document);
  const outbox = Object.fromEntries(
    Object.entries(state.outbox).filter(([key, entry]) => {
      const seen = remote.document[key];
      return seen === undefined || seen.h < entry.h;
    }),
  );
  return {
    snapshot: {
      environmentId: remote.environmentId,
      document,
      config: materialize(document),
    },
    outbox,
    clock: highestHlc(
      [state.clock, ...Object.values(remote.document).map((entry) => entry.h)],
      state.clock,
    ),
  };
}

/** Drops acknowledged entries; a different value under the same key stays pending. */
export function acknowledgeMeshLayoutEntries(
  state: MeshLayoutClientState,
  acknowledged: MeshLayoutDocument,
): MeshLayoutClientState {
  const outbox = Object.fromEntries(
    Object.entries(state.outbox).filter(([key, entry]) => {
      const acked = acknowledged[key];
      return acked === undefined || acked.h !== entry.h;
    }),
  );
  return { ...state, outbox };
}

/**
 * RPC errors that will not fix themselves: invalid entries, disabled storage and missing
 * permission. Transport failures stay queued.
 */
export function isPermanentMeshLayoutFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const tag = (error as { _tag?: unknown })._tag;
  if (tag === "EnvironmentAuthorizationError") return true;
  if (tag !== "MeshLayoutError") return false;
  const reason = (error as { reason?: unknown }).reason;
  return reason === "invalid_entries" || reason === "storage" || reason === "disabled";
}

/** Ports the client uses; tests supply an in-memory fake. */
export interface MeshLayoutRpcPort {
  readonly get: (environmentId: EnvironmentId) => Promise<RpcMeshLayoutSnapshot>;
  readonly apply: (
    environmentId: EnvironmentId,
    entries: MeshLayoutDocument,
  ) => Promise<RpcMeshLayoutSnapshot>;
  readonly subscribe: (
    environmentId: EnvironmentId,
    onSnapshot: (snapshot: RpcMeshLayoutSnapshot) => void,
    onFailure?: (error: unknown) => void,
  ) => () => void;
}

export interface MeshLayoutPersistencePort {
  readonly load: () => Promise<MeshLayoutClientState | null>;
  readonly save: (state: MeshLayoutClientState) => Promise<void>;
}

export interface MeshLayoutClientOptions {
  readonly rpc: MeshLayoutRpcPort;
  readonly persistence: MeshLayoutPersistencePort;
  readonly environments: () => ReadonlyArray<MeshLayoutSourceEnvironment>;
  readonly primaryEnvironmentId: () => EnvironmentId | null;
  readonly deviceId: string;
  readonly now: () => number;
  readonly onChange?: (state: MeshLayoutClientState) => void;
  readonly onPermanentFailure?: (error: unknown) => void;
}

function rpcSnapshot(snapshot: RpcMeshLayoutSnapshot): MeshLayoutSnapshot {
  return {
    environmentId: snapshot.environmentId,
    document: snapshot.document as MeshLayoutDocument,
    config: snapshot.config,
  };
}

/**
 * Owns the cached layout, the currently subscribed mesh server and the offline outbox. The hook
 * layer feeds it the connected environments and renders `state.snapshot.config`; `null` source
 * means the caller must use the legacy settings path.
 */
export class MeshLayoutClient {
  private state: MeshLayoutClientState = emptyMeshLayoutState();
  private source: EnvironmentId | null = null;
  private unsubscribe: (() => void) | null = null;
  private failedSources = new Set<EnvironmentId>();
  private replaying: Promise<void> | null = null;
  private disposed = false;
  private readonly options: MeshLayoutClientOptions;

  constructor(options: MeshLayoutClientOptions) {
    this.options = options;
  }

  get current(): MeshLayoutClientState {
    return this.state;
  }

  get sourceEnvironmentId(): EnvironmentId | null {
    return this.source;
  }

  private now(): number {
    return this.options.now();
  }

  private emit() {
    this.options.onChange?.(this.state);
  }

  private async persist() {
    await this.options.persistence.save(this.state);
  }

  async start(): Promise<void> {
    const cached = await this.options.persistence.load();
    if (cached !== null) {
      this.state = cached;
      this.emit();
    }
    await this.refreshEnvironments();
  }

  /** Re-evaluates the source after connections change; fails over when the source went away. */
  async refreshEnvironments(): Promise<void> {
    if (this.disposed) return;
    for (const environment of this.options.environments()) {
      if (!environment.connected) this.failedSources.delete(environment.environmentId);
    }
    const available = this.options
      .environments()
      .filter(
        (environment) =>
          environment.connected &&
          environment.capabilities?.meshLayout === true &&
          !this.failedSources.has(environment.environmentId),
      );
    let next = pickMeshSource(available, this.options.primaryEnvironmentId());
    // A source that failed is excluded only when another source exists; keep its subscription
    // otherwise so a transient disconnect recovers without losing the cache.
    if (next === null && this.source !== null) return;
    if (next === this.source && this.unsubscribe !== null) {
      await this.replayOutbox();
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.source = next;
    if (next === null) return;
    this.unsubscribe = this.options.rpc.subscribe(
      next,
      (snapshot) => {
        if (this.disposed || this.source !== next) return;
        this.state = mergeMeshLayoutSnapshot(this.state, rpcSnapshot(snapshot), this.now());
        this.emit();
        void this.persist().then(() => this.replayOutbox());
      },
      (error) => {
        if (this.disposed || this.source !== next) return;
        this.failedSources.add(next);
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.source = null;
        this.options.onPermanentFailure?.(error);
        void this.refreshEnvironments();
      },
    );
    try {
      const snapshot = await this.options.rpc.get(next);
      this.state = mergeMeshLayoutSnapshot(this.state, rpcSnapshot(snapshot), this.now());
      this.emit();
      await this.persist();
    } catch (error) {
      if (isPermanentMeshLayoutFailure(error)) this.options.onPermanentFailure?.(error);
    }
    await this.replayOutbox();
  }

  /** Applies an edit optimistically and sends its entries to the current source. */
  async edit(
    update: (config: SidebarWorkspacesConfigType) => SidebarWorkspacesConfigType,
  ): Promise<MeshLayoutDocument> {
    const { state, entries } = editMeshLayout(this.state, update, {
      deviceId: this.options.deviceId,
      now: this.now(),
    });
    this.state = state;
    this.emit();
    await this.persist();
    const source = this.source;
    if (source === null || Object.keys(entries).length === 0) return entries;
    try {
      const snapshot = await this.options.rpc.apply(source, entries);
      this.state = acknowledgeMeshLayoutEntries(
        mergeMeshLayoutSnapshot(this.state, rpcSnapshot(snapshot), this.now()),
        entries,
      );
      this.emit();
      await this.persist();
    } catch (error) {
      if (isPermanentMeshLayoutFailure(error)) {
        this.state = acknowledgeMeshLayoutEntries(this.state, entries);
        this.options.onPermanentFailure?.(error);
        await this.persist();
      }
    }
    return entries;
  }

  /** Sends queued entries again; safe to call on every reconnect. */
  async replayOutbox(): Promise<void> {
    if (this.replaying !== null) return this.replaying;
    const source = this.source;
    if (source === null || Object.keys(this.state.outbox).length === 0) return;
    const entries = this.state.outbox;
    this.replaying = (async () => {
      try {
        const snapshot = await this.options.rpc.apply(source, entries);
        this.state = acknowledgeMeshLayoutEntries(
          mergeMeshLayoutSnapshot(this.state, rpcSnapshot(snapshot), this.now()),
          entries,
        );
        this.emit();
        await this.persist();
      } catch (error) {
        if (isPermanentMeshLayoutFailure(error)) {
          this.state = acknowledgeMeshLayoutEntries(this.state, entries);
          this.options.onPermanentFailure?.(error);
          await this.persist();
        }
      }
    })().finally(() => {
      this.replaying = null;
    });
    return this.replaying;
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.source = null;
  }
}

/** Atom families for the mesh layout RPCs, shared by web and mobile. */
export function createMeshLayoutAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    subscribe: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:mesh-layout:subscribe",
      tag: MESH_WS_METHODS.layoutSubscribe,
    }),
    get: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mesh-layout:get",
      tag: MESH_WS_METHODS.layoutGet,
    }),
    apply: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mesh-layout:apply",
      tag: MESH_WS_METHODS.layoutApply,
    }),
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mesh-layout:status",
      tag: MESH_WS_METHODS.status,
    }),
  };
}
