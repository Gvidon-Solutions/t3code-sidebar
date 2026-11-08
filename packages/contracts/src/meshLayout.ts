import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  MeshVersionUpdateInput,
  MeshConfigApplyInput,
  MeshConfigError,
  MeshConfigPlan,
  MeshConfigPlanInput,
  MeshConfigRevision,
  MeshConfigSnapshot,
  MeshConfigStatus,
} from "./meshConfig.ts";
import {
  PeerConnectionStatus,
  SidebarProjectMount,
  SidebarProjectMountStatus,
  SidebarProjectMountState,
  SidebarWorkspacesConfig,
} from "./sidebarWorkspaces.ts";

/**
 * T3 Mesh (fork): the shared layout document every server replicates and every client reads.
 * Entries follow `@t3tools/shared/meshLayout` (LWW per key; `v: null` is a tombstone).
 */
export const Hlc = Schema.String.check(Schema.isPattern(/^\d{13}\.\d{5}\..+$/));

export const MeshLayoutEntry = Schema.Struct({
  v: Schema.Unknown,
  h: Hlc,
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
  lag: Schema.optionalKey(
    Schema.Struct({
      filesBehind: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      bytesBehind: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ),
  skipped: SidebarProjectMountStatus.fields.skipped,
  skippedPaths: SidebarProjectMountStatus.fields.skippedPaths,
  conflictCopies: Schema.optionalKey(
    Schema.Struct({
      environmentId: Schema.String,
      path: Schema.String,
      locations: Schema.optionalKey(
        Schema.Array(Schema.Struct({ environmentId: Schema.String, path: Schema.String })),
      ),
    }),
  ),
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

/** Replication bookkeeping for one peer, as the server last recorded it. */
export const MeshPeerState = Schema.Struct({
  environmentId: Schema.String,
  lastExchangeAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  sentSeq: Schema.Int,
  receivedSeq: Schema.Int,
});
export type MeshPeerState = typeof MeshPeerState.Type;

export const MeshLayoutStatus = Schema.Struct({
  quarantine: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, reason: Schema.String })),
  ),
  clockRejections: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ peerId: Schema.String, count: Schema.Int, example: Schema.String }),
    ),
  ),
  peers: Schema.Array(MeshPeerState),
  connections: Schema.optionalKey(Schema.Array(PeerConnectionStatus)),
});
export type MeshLayoutStatus = typeof MeshLayoutStatus.Type;

export const MESH_WS_METHODS = {
  layoutGet: "meshLayout.get",
  layoutApply: "meshLayout.apply",
  layoutSubscribe: "meshLayout.subscribe",
  status: "meshLayout.status",
  replicasStatus: "replicas.status",
  replicasRetry: "replicas.retry",
  replicasUnmanaged: "replicas.unmanaged",
  replicasAdopt: "replicas.adopt",
  configGet: "meshConfig.get",
  configPlan: "meshConfig.plan",
  configApply: "meshConfig.apply",
  updateVersion: "meshConfig.updateVersion",
  configStatus: "meshConfig.status",
} as const;

const LayoutError = Schema.Union([MeshLayoutError, EnvironmentAuthorizationError]);
const ReplicaRpcError = Schema.Union([ReplicaError, EnvironmentAuthorizationError]);
const ConfigRpcError = Schema.Union([MeshConfigError, EnvironmentAuthorizationError]);

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
/** Per-peer replication state: when the last exchange ran and what it last reported. */
const WsMeshLayoutStatusRpc = Rpc.make(MESH_WS_METHODS.status, {
  payload: Schema.Struct({}),
  success: MeshLayoutStatus,
  error: LayoutError,
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

export const ProjectPlaceInput = Schema.Struct({
  project: Schema.String,
  machine: Schema.String,
  action: Schema.optionalKey(Schema.Literals(["add", "remove"])),
  role: Schema.optionalKey(Schema.Literals(["primary", "replica"])),
  source: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  ignores: Schema.optionalKey(Schema.Array(Schema.String)),
  transport: Schema.optionalKey(Schema.Literals(["mutagen", "sshfs", "manual"])),
  wait: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 600 }))),
});
export type ProjectPlaceInput = typeof ProjectPlaceInput.Type;
export const ProjectPlaceResult = Schema.Struct({
  logicalKey: Schema.String,
  representation: Schema.NullOr(SidebarProjectMount),
  ready: Schema.Boolean,
});
export type ProjectPlaceResult = typeof ProjectPlaceResult.Type;
export const ProjectMachinesResult = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  logicalKey: Schema.String,
  representations: Schema.Array(
    Schema.Struct({
      ...SidebarProjectMount.fields,
      machine: Schema.String,
      tag: Schema.optionalKey(Schema.String),
      driverEnvironmentId: Schema.optionalKey(Schema.String),
      status: Schema.optionalKey(SidebarProjectMountStatus),
      live: Schema.optionalKey(ReplicaLiveStatus),
    }),
  ),
});
export type ProjectMachinesResult = typeof ProjectMachinesResult.Type;

const SyncEndpoint = Schema.Struct({
  path: Schema.String,
  protocol: Schema.optionalKey(Schema.String),
  host: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Number),
});
export const UnmanagedSyncSession = Schema.Struct({
  identifier: Schema.String,
  name: Schema.optionalKey(Schema.String),
  alpha: SyncEndpoint,
  beta: SyncEndpoint,
  ignores: Schema.Array(Schema.String),
});
export type UnmanagedSyncSession = typeof UnmanagedSyncSession.Type;
export const ReplicaAdoptInput = Schema.Struct({
  project: Schema.String,
  session: Schema.String,
  machine: Schema.optionalKey(Schema.String),
});
export type ReplicaAdoptInput = typeof ReplicaAdoptInput.Type;
const WsReplicasUnmanagedRpc = Rpc.make(MESH_WS_METHODS.replicasUnmanaged, {
  payload: Schema.Struct({}),
  success: Schema.Array(UnmanagedSyncSession),
  error: ReplicaRpcError,
});
const WsReplicasAdoptRpc = Rpc.make(MESH_WS_METHODS.replicasAdopt, {
  payload: ReplicaAdoptInput,
  success: ProjectPlaceResult,
  error: ReplicaRpcError,
});
const WsMeshConfigGetRpc = Rpc.make(MESH_WS_METHODS.configGet, {
  payload: Schema.Struct({}),
  success: MeshConfigSnapshot,
  error: ConfigRpcError,
});
const WsMeshConfigPlanRpc = Rpc.make(MESH_WS_METHODS.configPlan, {
  payload: MeshConfigPlanInput,
  success: MeshConfigPlan,
  error: ConfigRpcError,
});
const WsMeshConfigApplyRpc = Rpc.make(MESH_WS_METHODS.configApply, {
  payload: MeshConfigApplyInput,
  success: MeshConfigRevision,
  error: ConfigRpcError,
});
const WsMeshConfigStatusRpc = Rpc.make(MESH_WS_METHODS.configStatus, {
  payload: Schema.Struct({}),
  success: MeshConfigStatus,
  error: ConfigRpcError,
});
const WsMeshVersionUpdateRpc = Rpc.make(MESH_WS_METHODS.updateVersion, {
  payload: MeshVersionUpdateInput,
  success: Schema.Union([MeshConfigPlan, MeshConfigRevision]),
  error: ConfigRpcError,
});
export const MeshRpcs = [
  WsMeshLayoutGetRpc,
  WsMeshLayoutApplyRpc,
  WsMeshLayoutSubscribeRpc,
  WsMeshLayoutStatusRpc,
  WsReplicasStatusRpc,
  WsReplicasRetryRpc,
  WsReplicasUnmanagedRpc,
  WsReplicasAdoptRpc,
  WsMeshConfigGetRpc,
  WsMeshConfigPlanRpc,
  WsMeshConfigApplyRpc,
  WsMeshConfigStatusRpc,
  WsMeshVersionUpdateRpc,
] as const;
