import {
  MESH_WS_METHODS,
  MeshLayoutEntries,
  Hlc as HlcSchema,
  type EnvironmentId,
  type MeshLayoutSnapshot as RpcMeshLayoutSnapshot,
  type SidebarWorkspacesConfig as SidebarWorkspacesConfigType,
} from "@t3tools/contracts";
import {
  materialize,
  migrateLogicalProjectIds,
  merge,
  keys,
  type Hlc,
  type MeshLayoutDocument,
} from "@t3tools/shared/meshLayout";
import {
  acknowledgeMeshLayoutEntries,
  editMeshLayout,
  highestHlc,
  isPermanentMeshLayoutFailure,
  mergeMeshLayoutSnapshot,
  type EditResult,
} from "./meshLayoutClientInternals.ts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
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
    }),
  ),
  outbox: MeshLayoutEntries,
  clock: Schema.NullOr(HlcSchema),
});

const decodeCache = Schema.decodeUnknownSync(Schema.fromJsonString(MeshLayoutCacheSchema));
const encodeCache = Schema.encodeSync(Schema.fromJsonString(MeshLayoutCacheSchema));

/** Decodes a persisted cache, returning `null` for missing or corrupt data instead of throwing. */
export function parseMeshLayoutCache(json: string | null): MeshLayoutClientState | null {
  if (json === null || json.trim() === "") return null;
  try {
    const parsed = decodeCache(json);
    const document = (parsed.snapshot?.document ?? {}) as MeshLayoutDocument;
    return {
      snapshot: parsed.snapshot
        ? {
            environmentId: parsed.snapshot.environmentId ?? "",
            document,
            config: materialize(document),
          }
        : null,
      outbox: parsed.outbox as MeshLayoutDocument,
      clock: parsed.clock,
    };
  } catch (error) {
    Effect.runSync(Effect.logWarning("Unable to decode mesh layout cache", error));
    return null;
  }
}

export function serializeMeshLayoutCache(state: MeshLayoutClientState): string {
  return encodeCache(state);
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
export class MeshLayoutStore {
  private state: MeshLayoutClientState = emptyMeshLayoutState();
  private confirmedDocument: MeshLayoutDocument = {};

  private migrateHydratedCache = false;
  private acceptSnapshot(snapshot: RpcMeshLayoutSnapshot) {
    if (this.migrateHydratedCache) {
      this.migrateHydratedCache = false;
      const aliases = merge(
        this.state.snapshot?.document ?? {},
        snapshot.document as MeshLayoutDocument,
      );
      const outbox = migrateLogicalProjectIds(this.state.outbox, aliases);
      const document = migrateLogicalProjectIds(aliases);
      this.confirmedDocument = migrateLogicalProjectIds(this.confirmedDocument, aliases);
      if (this.state.snapshot)
        this.state = {
          ...this.state,
          outbox,
          snapshot: { ...this.state.snapshot, document, config: materialize(document) },
        };
    }
    this.confirmedDocument = merge(this.confirmedDocument, snapshot.document as MeshLayoutDocument);
    this.state = mergeMeshLayoutSnapshot(this.state, rpcSnapshot(snapshot));
  }

  private rejectEntries(entries: MeshLayoutDocument) {
    this.state = acknowledgeMeshLayoutEntries(this.state, entries);
    if (this.state.snapshot) {
      const document = merge(this.confirmedDocument, this.state.outbox);
      this.state = {
        ...this.state,
        snapshot: { ...this.state.snapshot, document, config: materialize(document) },
      };
    }
    this.emit();
  }
  private listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.state;
  private cacheHydrated = false;
  hydrate(state: MeshLayoutClientState) {
    if (this.cacheHydrated) return;
    this.cacheHydrated = true;
    this.migrateHydratedCache = true;
    const restored =
      this.state.snapshot === null ? state : mergeMeshLayoutSnapshot(state, this.state.snapshot);
    this.confirmedDocument = merge(
      this.confirmedDocument,
      Object.fromEntries(
        Object.entries(restored.snapshot?.document ?? {}).filter(
          ([key]) => !Object.hasOwn(restored.outbox, key),
        ),
      ),
    );
    this.state = {
      ...restored,
      outbox: merge(restored.outbox, this.state.outbox),
      clock: highestHlc([restored.clock, this.state.clock], null),
    };
    this.emit();
  }
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
    for (const listener of this.listeners) listener();
  }

  private async persist() {
    await this.options.persistence.save(this.state);
  }

  async start(): Promise<void> {
    this.disposed = false;
    const cached = await this.options.persistence.load();
    if (cached !== null) {
      this.hydrate(cached);
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
        this.acceptSnapshot(snapshot);
        this.emit();
        void this.persist()
          .then(() => this.replayOutbox())
          .catch((error) => this.options.onPermanentFailure?.(error));
      },
      (error) => {
        if (this.disposed || this.source !== next) return;
        this.failedSources.add(next);
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.source = null;
        if (isPermanentMeshLayoutFailure(error)) this.options.onPermanentFailure?.(error);
        void this.refreshEnvironments().catch((error) => this.options.onPermanentFailure?.(error));
      },
    );
    try {
      const snapshot = await this.options.rpc.get(next);
      this.acceptSnapshot(snapshot);
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
    let result: EditResult;
    try {
      result = editMeshLayout(this.state, update, {
        deviceId: this.options.deviceId,
        now: this.now(),
      });
    } catch (error) {
      this.options.onPermanentFailure?.(error);
      throw error;
    }
    const { state, entries } = result;
    this.state = state;
    this.emit();
    await this.persist();
    const source = this.source;
    if (source === null || Object.keys(entries).length === 0) return entries;
    try {
      const snapshot = await this.options.rpc.apply(source, entries);
      this.acceptSnapshot(snapshot);
      this.state = acknowledgeMeshLayoutEntries(this.state, entries);
      this.emit();
      await this.persist();
    } catch (error) {
      if (isPermanentMeshLayoutFailure(error)) {
        this.rejectEntries(entries);
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
        this.acceptSnapshot(snapshot);
        this.state = acknowledgeMeshLayoutEntries(this.state, entries);
        this.emit();
        await this.persist();
      } catch (error) {
        if (isPermanentMeshLayoutFailure(error)) {
          this.rejectEntries(entries);
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
  const subscribe = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:mesh-layout:subscribe",
    tag: MESH_WS_METHODS.layoutSubscribe,
  });
  const connectionChanges = Atom.family((environmentId: EnvironmentId) =>
    subscribe({ environmentId, input: {} }).pipe(
      Atom.map(
        (result) =>
          AsyncResult.getOrElse(result, () => null)?.document[keys.machine(environmentId)]?.h ?? "",
      ),
    ),
  );
  return {
    subscribe,
    configGet: createEnvironmentRpcCommand(runtime, {
      label: "mesh-config:get",
      tag: MESH_WS_METHODS.configGet,
    }),
    configPlan: createEnvironmentRpcCommand(runtime, {
      label: "mesh-config:plan",
      tag: MESH_WS_METHODS.configPlan,
    }),
    configApply: createEnvironmentRpcCommand(runtime, {
      label: "mesh-config:apply",
      tag: MESH_WS_METHODS.configApply,
    }),
    configStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "mesh-config:status",
      tag: MESH_WS_METHODS.configStatus,
      refreshIntervalMs: 5_000,
      refreshTrigger: ({ environmentId }) => connectionChanges(environmentId),
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
      refreshIntervalMs: 60_000,
      refreshTrigger: ({ environmentId }) => connectionChanges(environmentId),
    }),
  };
}

export * from "./meshConfigEditor.ts";
