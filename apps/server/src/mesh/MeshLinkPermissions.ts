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
    files: fileRank[ceiling] < fileRank[permissions.files] ? ceiling : permissions.files,
    linked: true,
  };
});
