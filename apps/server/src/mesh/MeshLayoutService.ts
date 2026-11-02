import type { SidebarWorkspacesConfig } from "@t3tools/contracts";
import type { Hlc, MeshLayoutDocument } from "@t3tools/shared/meshLayout";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

/**
 * T3 Mesh (fork): this server's replica of the shared layout document. Stage C implements it
 * (store, legacy import, replication); other server code (replicas, MCP tools) only uses this
 * interface. Entries are merged with the CRDT rules of `meshLayout/document.ts`.
 */
export interface MeshLayoutSnapshot {
  readonly document: MeshLayoutDocument;
  /** `materialize(document)`, the shape every client and the pure workspace functions use. */
  readonly config: SidebarWorkspacesConfig;
}

export class MeshLayoutService extends Context.Service<
  MeshLayoutService,
  {
    /** This environment's id (the HLC suffix). */
    readonly environmentId: string;
    readonly read: Effect.Effect<MeshLayoutSnapshot>;
    /** Merges entries (local edits or replicated ones) and notifies subscribers when anything changed. */
    readonly apply: (entries: MeshLayoutDocument) => Effect.Effect<MeshLayoutSnapshot>;
    /** Stamps a local edit: `diff` the configs and apply the resulting entries with fresh clocks. */
    readonly edit: (
      update: (config: SidebarWorkspacesConfig) => SidebarWorkspacesConfig,
    ) => Effect.Effect<MeshLayoutSnapshot>;
    /** A fresh clock for entries this server writes itself. */
    readonly nextHlc: Effect.Effect<Hlc>;
    /** Every merged change, current snapshot first. */
    readonly changes: Stream.Stream<MeshLayoutSnapshot>;
  }
>()("t3/mesh/MeshLayoutService") {}
