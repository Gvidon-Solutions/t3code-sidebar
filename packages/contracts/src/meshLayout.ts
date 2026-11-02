import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { SidebarProjectMountState, SidebarWorkspacesConfig } from "./sidebarWorkspaces.ts";

/**
 * T3 Mesh (fork): the shared layout document every server replicates and every client reads.
 * Entries follow `@t3tools/shared/meshLayout` (LWW per key; `v: null` is a tombstone).
 */
export const MeshLayoutEntry = Schema.Struct({
  v: Schema.Unknown,
  h: Schema.String,
});
export type MeshLayoutEntry = typeof MeshLayoutEntry.Type;

export const MeshLayoutEntries = Schema.Record(Schema.String, MeshLayoutEntry);
export type MeshLayoutEntries = typeof MeshLayoutEntries.Type;

export const MeshLayoutSnapshot = Schema.Struct({
  environmentId: Schema.String,
  document: MeshLayoutEntries,
  /** `materialize(document)`. */
  config: SidebarWorkspacesConfig,
});
export type MeshLayoutSnapshot = typeof MeshLayoutSnapshot.Type;

export const MeshLayoutApplyInput = Schema.Struct({ entries: MeshLayoutEntries });
export type MeshLayoutApplyInput = typeof MeshLayoutApplyInput.Type;

export class MeshLayoutError extends Schema.TaggedError<MeshLayoutError>()("MeshLayoutError", {
  reason: Schema.Literals(["invalid_entries", "storage", "disabled"]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Live state of one replica on the machine that drives or holds it. */
export const ReplicaLiveStatus = Schema.Struct({
  logicalKey: Schema.String,
  environmentId: Schema.String,
  state: SidebarProjectMountState,
  /** 0..1 while staging the first sync. */
  progress: Schema.optionalKey(Schema.Number),
  conflicts: Schema.Array(Schema.String),
  problems: Schema.Array(Schema.String),
  message: Schema.optionalKey(Schema.String),
  sessionName: Schema.optionalKey(Schema.String),
  localPath: Schema.optionalKey(Schema.String),
  projectId: Schema.optionalKey(Schema.String),
  updatedAt: Schema.String,
});
export type ReplicaLiveStatus = typeof ReplicaLiveStatus.Type;

export const ReplicaRefInput = Schema.Struct({
  logicalKey: Schema.String,
  environmentId: Schema.String,
});
export type ReplicaRefInput = typeof ReplicaRefInput.Type;

export class ReplicaError extends Schema.TaggedError<ReplicaError>()("ReplicaError", {
  reason: Schema.Literals(["not_found", "unreachable", "mutagen", "disabled", "storage"]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const MESH_WS_METHODS = {
  layoutGet: "meshLayout.get",
  layoutApply: "meshLayout.apply",
  layoutSubscribe: "meshLayout.subscribe",
  replicasStatus: "replicas.status",
  replicasRetry: "replicas.retry",
} as const;

const LayoutError = Schema.Union([MeshLayoutError, EnvironmentAuthorizationError]);
const ReplicaRpcError = Schema.Union([ReplicaError, EnvironmentAuthorizationError]);

export const WsMeshLayoutGetRpc = Rpc.make(MESH_WS_METHODS.layoutGet, {
  payload: Schema.Struct({}),
  success: MeshLayoutSnapshot,
  error: LayoutError,
});
export const WsMeshLayoutApplyRpc = Rpc.make(MESH_WS_METHODS.layoutApply, {
  payload: MeshLayoutApplyInput,
  success: MeshLayoutSnapshot,
  error: LayoutError,
});
/** The snapshot now, then one after every merged change. */
export const WsMeshLayoutSubscribeRpc = Rpc.make(MESH_WS_METHODS.layoutSubscribe, {
  payload: Schema.Struct({}),
  success: MeshLayoutSnapshot,
  error: LayoutError,
  stream: true,
});
/** Every replica this server drives or holds, re-sent on change (progress included). */
export const WsReplicasStatusRpc = Rpc.make(MESH_WS_METHODS.replicasStatus, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ replicas: Schema.Array(ReplicaLiveStatus) }),
  error: ReplicaRpcError,
  stream: true,
});
export const WsReplicasRetryRpc = Rpc.make(MESH_WS_METHODS.replicasRetry, {
  payload: ReplicaRefInput,
  success: ReplicaLiveStatus,
  error: ReplicaRpcError,
});

export const MeshRpcs = [
  WsMeshLayoutGetRpc,
  WsMeshLayoutApplyRpc,
  WsMeshLayoutSubscribeRpc,
  WsReplicasStatusRpc,
  WsReplicasRetryRpc,
] as const;
