import { diff, merge, tick, type Hlc, type MeshLayoutDocument } from "@t3tools/shared/meshLayout";
import { materialize } from "@t3tools/shared/meshLayout";
import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

import type { MeshLayoutClientState, MeshLayoutSnapshot } from "./meshLayoutClient.ts";

// Pure state transforms for MeshLayoutStore. Kept off the public package entry: apps render the
// store, and only this package's tests exercise the individual steps.

export interface EditResult {
  readonly state: MeshLayoutClientState;
  readonly entries: MeshLayoutDocument;
}

/** Applies an edit locally and returns the entries to send. Never mutates `state`. */
export function editMeshLayout(
  state: MeshLayoutClientState,
  update: (config: SidebarWorkspacesConfig) => SidebarWorkspacesConfig,
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

export function highestHlc(
  hlcs: ReadonlyArray<Hlc | null | undefined>,
  fallback: Hlc | null,
): Hlc | null {
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
  if (tag === "EnvironmentAuthorizationError") return false;
  if (tag !== "MeshLayoutError") return false;
  const reason = (error as { reason?: unknown }).reason;
  return reason === "invalid_entries" || reason === "storage" || reason === "disabled";
}
