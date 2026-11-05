import {
  bindingsFromLayout,
  configFromLayout,
  effectiveLinkPermissions,
  machineByEnvironment,
  machineByPeerLabel,
} from "@t3tools/shared/meshConfig";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import type { PeerCallLimits } from "../peer/PeerMcpClient.ts";

const defaults = { files: "projects" as const, replicas: true, threads: true };
const fileRank = { none: 0, projects: 1, all: 2 };
export const linkPermissions = Effect.fn("MeshLinkPermissions.read")(function* (
  targetEnvironmentId?: string,
) {
  const invocation = yield* Effect.serviceOption(McpInvocationContext);
  if (Option.isNone(invocation) || invocation.value.client?.linked !== true)
    return { ...defaults, linked: false };
  const scope = invocation.value;
  const client = scope.client!;
  const mesh = yield* Effect.serviceOption(MeshLayoutService);
  const document = Option.isSome(mesh) ? (yield* mesh.value.read).document : {};
  const config = configFromLayout(document);
  const bindings = bindingsFromLayout(document);
  const self = config
    ? machineByEnvironment(config, bindings, targetEnvironmentId ?? scope.environmentId)
    : undefined;
  const peer = config
    ? client.peerEnvironmentId
      ? machineByEnvironment(config, bindings, client.peerEnvironmentId)
      : undefined
    : undefined;
  const legacyPeers =
    config && !client.peerEnvironmentId
      ? Object.entries(bindings).flatMap(([name, environmentId]) =>
          environmentId !== scope.environmentId &&
          machineByPeerLabel(config, { [name]: environmentId }, client.label)
            ? [name]
            : [],
        )
      : [];
  const peers = peer ? [peer.name] : legacyPeers.length ? legacyPeers : [""];
  const permissions = (
    config
      ? peers.map((name) => effectiveLinkPermissions(config, self?.name ?? "", name))
      : [defaults]
  ).reduce((a, b) => ({
    files: fileRank[a.files] < fileRank[b.files] ? a.files : b.files,
    replicas: a.replicas && b.replicas,
    threads: a.threads && b.threads,
  }));
  const requested = client.filesLimit ?? "all";
  const ceiling = client.access === "read-only" && requested === "all" ? "projects" : requested;
  return {
    ...permissions,
    replicas: permissions.replicas && client.replicasLimit !== false,
    files: fileRank[ceiling] < fileRank[permissions.files] ? ceiling : permissions.files,
    linked: true,
  };
});

export const forwardedCallLimits = Effect.fn("MeshLinkPermissions.forwardedCallLimits")(function* (
  tool: string,
  limits: PeerCallLimits,
  targetEnvironmentId?: string,
) {
  const local = yield* linkPermissions();
  const target = targetEnvironmentId ? yield* linkPermissions(targetEnvironmentId) : local;
  const threads =
    tool.startsWith("t3_thread_") ||
    tool.startsWith("t3_attachment_") ||
    [
      "t3_queue",
      "t3_pending_request",
      "create_threads",
      "delegate_task",
      "task_status",
      "task_cancel",
    ].includes(tool);
  const replicas =
    tool === "t3_project_place" || tool === "t3_replica_adopt" || tool === "t3_run_runtime";
  const files = tool === "t3_files_read" || tool === "t3_files_list";
  if (
    (threads && (!local.threads || !target.threads)) ||
    (replicas && (!local.replicas || !target.replicas || limits.replicas === false)) ||
    (files && (local.files === "none" || target.files === "none" || limits.files === "none"))
  )
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This mesh link does not allow the forwarded operation.",
    });
  const incoming = limits.files ?? "all";
  const ceiling = fileRank[local.files] < fileRank[target.files] ? local.files : target.files;
  return {
    ...limits,
    files: fileRank[incoming] < fileRank[ceiling] ? incoming : ceiling,
    replicas: local.replicas && target.replicas && limits.replicas !== false,
  };
});
