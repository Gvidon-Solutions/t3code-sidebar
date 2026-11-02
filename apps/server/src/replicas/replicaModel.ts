// @effect-diagnostics-next-line nodeBuiltinImport:off -- Session names require a synchronous deterministic hash, without a runtime.
import * as NodeCrypto from "node:crypto";
import type {
  SidebarProjectMount,
  SidebarWorkspacesConfig,
  ReplicaLiveStatus,
} from "@t3tools/contracts";
import type { MutagenSession } from "./MutagenRunner.ts";

export function sessionIdentity(logicalKey: string, environmentId: string) {
  const logicalHash = NodeCrypto.createHash("sha256").update(logicalKey).digest("hex").slice(0, 8);
  const environmentTag = environmentId.slice(0, 8);
  return { name: `t3-${logicalHash}-${environmentTag}`, logicalHash, environmentTag };
}
export function replicaDriver(config: SidebarWorkspacesConfig, replica: SidebarProjectMount) {
  if (!replica.source) return undefined;
  if (config.machines[replica.environmentId]?.reach?.[replica.source]?.ssh)
    return replica.environmentId;
  if (config.machines[replica.source]?.reach?.[replica.environmentId]?.ssh) return replica.source;
  return undefined;
}
export function sessionStatus(
  session: MutagenSession,
): Pick<ReplicaLiveStatus, "state" | "progress" | "conflicts" | "problems"> {
  const conflicts = session.conflicts?.map((conflict) => conflict.root) ?? [];
  const problems = [
    session.lastError,
    ...[session.alpha, session.beta].flatMap((endpoint) =>
      [...(endpoint.scanProblems ?? []), ...(endpoint.transitionProblems ?? [])].map(
        (problem) => `${problem.path}: ${problem.error}`,
      ),
    ),
  ].filter((value): value is string => Boolean(value));
  const staging = session.beta.stagingProgress ?? session.alpha.stagingProgress;
  return {
    state: session.paused
      ? "paused"
      : problems.length > 0
        ? "error"
        : conflicts.length > 0
          ? "conflict"
          : session.status === "watching"
            ? "watching"
            : "mounting",
    ...(staging && staging.totalSize > 0
      ? { progress: Math.min(1, staging.receivedSize / staging.totalSize) }
      : {}),
    conflicts,
    problems,
  };
}

export function sshEndpoint(
  route: { readonly ssh: string; readonly identityFile?: string },
  environmentId: string,
  root: string,
) {
  if (route.identityFile) return `t3-mesh-${environmentId}:${root}`;
  return /:\d+$/.test(route.ssh)
    ? `ssh://${route.ssh}${root.startsWith("/") ? "" : "/"}${root}`
    : `${route.ssh}:${root}`;
}
