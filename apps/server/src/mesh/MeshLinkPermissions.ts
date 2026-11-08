import { mcpDomainByName, linkAllowsDomain } from "../mcp/McpToolDomain.ts";
import {
  bindingsFromLayout,
  configFromLayout,
  effectiveLinkPermissions,
  machineByEnvironment,
} from "@t3tools/shared/meshConfig";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import type { PeerCallLimits } from "../peer/PeerMcpClient.ts";

const defaults = { files: "all" as const, replicas: true, threads: true };
const fileRank = { none: 0, projects: 1, all: 2 };
export const linkPermissions = Effect.fn("MeshLinkPermissions.read")(function* (
  targetEnvironmentId?: string,
) {
  const invocation = yield* Effect.serviceOption(McpInvocationContext);
  if (Option.isNone(invocation) || invocation.value.client?.linked !== true)
    return { ...defaults, linked: false };
  const scope = invocation.value;
  const client = scope.client!;
  const mesh = yield* MeshLayoutService;
  const document = (yield* mesh.read).document;
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
  const permissions =
    config && self && peer && self.name !== peer.name
      ? effectiveLinkPermissions(config, self.name, peer.name)
      : { files: "none" as const, replicas: false, threads: false };
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
  const domain = mcpDomainByName(tool);
  const scope = yield* Effect.serviceOption(McpInvocationContext);
  const identified =
    !local.linked || (Option.isSome(scope) && scope.value.client?.peerEnvironmentId !== undefined);
  const incoming = limits.files ?? "all";
  const ceiling = fileRank[local.files] < fileRank[target.files] ? local.files : target.files;
  const files = fileRank[incoming] < fileRank[ceiling] ? incoming : ceiling;
  const replicas = local.replicas && target.replicas && limits.replicas !== false;
  if (
    !linkAllowsDomain(
      domain,
      { files, replicas, threads: local.threads && target.threads },
      identified,
    )
  )
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This mesh link does not allow the forwarded operation.",
    });
  return { ...limits, files, replicas };
});
