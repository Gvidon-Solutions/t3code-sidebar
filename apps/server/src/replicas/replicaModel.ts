import { projectPolicy } from "@t3tools/shared/meshConfig";
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
): Pick<
  ReplicaLiveStatus,
  "state" | "progress" | "conflicts" | "problems" | "message" | "skipped" | "skippedPaths"
> {
  const conflicts = session.conflicts?.map((conflict) => conflict.root) ?? [];
  const problems = [
    session.lastError,
    ...[session.alpha, session.beta].flatMap((endpoint) =>
      (endpoint.transitionProblems ?? []).map((problem) => `${problem.path}: ${problem.error}`),
    ),
  ].filter((value): value is string => Boolean(value));
  const excludedTransitions =
    (session.alpha.excludedTransitionProblems ?? 0) +
    (session.beta.excludedTransitionProblems ?? 0);
  if (excludedTransitions > 0)
    problems.push(`${excludedTransitions} additional transition problems`);
  // First connection attempts are mounting; failed attempts carry lastError.
  if (!session.status.startsWith("connecting-")) {
    if (session.alpha.connected === false) problems.push("Primary is disconnected.");
    if (session.beta.connected === false) problems.push("Replica is disconnected.");
  }
  const skippedPaths = [
    ...new Map(
      [session.alpha, session.beta]
        .flatMap((endpoint) => endpoint.scanProblems ?? [])
        .map((problem) => [problem.path, problem]),
    ).values(),
  ];
  const skipped = [session.alpha, session.beta].reduce(
    (count, endpoint) =>
      count + (endpoint.scanProblems?.length ?? 0) + (endpoint.excludedScanProblems ?? 0),
    0,
  );
  const reasons = [
    skippedPaths.some((problem) => /symlink|symbolic link/iu.test(problem.error))
      ? "symlinks outside the project"
      : "",
    skippedPaths.some((problem) => /permission|unreadable|access denied/iu.test(problem.error))
      ? "unreadable files"
      : "",
  ].filter(Boolean);
  const message = problems.length
    ? problems.slice(0, 3).join("; ")
    : skipped
      ? `${skipped} ${skipped === 1 ? "file" : "files"} skipped (${reasons.join(", ") || "scan problems"})`
      : undefined;
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
    ...(staging && staging.expectedFiles > 0
      ? {
          progress: Math.max(
            0,
            Math.min(
              1,
              (staging.receivedFiles +
                (staging.expectedSize > 0 ? staging.receivedSize / staging.expectedSize : 0)) /
                staging.expectedFiles,
            ),
          ),
        }
      : {}),
    conflicts,
    problems,
    ...(message ? { message } : {}),
    ...(skipped ? { skipped, skippedPaths: skippedPaths.slice(0, 10) } : {}),
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

export function remoteRepresentation(
  config: SidebarWorkspacesConfig,
  local: { readonly environmentId: string; readonly id: string; readonly workspaceRoot: string },
  target: string,
) {
  const normalize = (root: string) => root.replaceAll("\\", "/").replace(/\/+$/, "");
  let key = Object.keys(config.projectMounts).find((key) =>
    config.projectMounts[key]!.some(
      (rep) =>
        rep.environmentId === local.environmentId &&
        (rep.projectId === local.id || normalize(rep.path) === normalize(local.workspaceRoot)),
    ),
  );
  if (!key) return undefined;
  const visited = new Set<string>();
  for (let hops = 0; hops < 8 && config.projectAliases[key] && !visited.has(key); hops++) {
    visited.add(key);
    key = config.projectAliases[key]!;
  }
  return config.projectMounts[key]?.find((rep) => rep.environmentId === target);
}

const protectedIgnores = [".git", ".svn", ".hg", ".bzr", "_darcs", "/.t3-conflicts"];
export function replicaIgnorePatterns(configured: readonly string[]): string[] {
  const defaults = projectPolicy({ schema: 1, machines: {} }, "").ignore.filter(
    (pattern) => !protectedIgnores.includes(pattern),
  );
  const alreadyPrefixed = defaults.every((pattern, index) => configured[index] === pattern);
  return [
    ...(alreadyPrefixed ? [] : defaults),
    ...configured.filter((pattern) => !protectedIgnores.includes(pattern)),
    ...protectedIgnores,
  ];
}
