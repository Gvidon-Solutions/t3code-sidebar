// @effect-diagnostics nodeBuiltinImport:off -- Representation mapping must support both Windows and POSIX paths regardless of the server OS.
import * as NodePath from "node:path";
import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

const pathApi = (root: string) =>
  /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? NodePath.win32 : NodePath.posix;
const subdirectory = (root: string, cwd: string) => {
  const path = pathApi(root);
  const relative = path.relative(root, cwd);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? undefined
    : relative;
};

export function resolveRunPlan(input: {
  readonly config: SidebarWorkspacesConfig;
  readonly environmentId: string;
  readonly cwd: string;
  readonly bindings: Readonly<Record<string, string>>;
  readonly sshMode?: "managed" | "existing" | "off";
}) {
  const matches = Object.entries(input.config.projectMounts)
    .flatMap(([logicalKey, representations]) =>
      representations
        .filter((rep) => rep.environmentId === input.environmentId)
        .flatMap((replica) => {
          const relative = subdirectory(replica.path, input.cwd);
          return relative === undefined ? [] : [{ logicalKey, representations, replica, relative }];
        }),
    )
    .sort((a, b) => b.replica.path.length - a.replica.path.length);
  const match = matches[0];
  if (!match || match.replica.role !== "replica" || match.replica.mode === "full")
    return { kind: "local" } as const;
  if (input.sshMode === "off")
    throw new Error("Mesh SSH is disabled; t3 run cannot reach the primary.");
  const primary = match.representations.find(
    (rep) => rep.environmentId === match.replica.source && rep.role === "primary",
  );
  if (!primary) throw new Error("The replica's primary representation is unavailable.");
  const names = Object.entries(input.bindings)
    .filter(([, id]) => id === primary.environmentId)
    .map(([name]) => name);
  if (names.length !== 1)
    throw new Error("The primary needs one bound machine name before t3 run can connect.");
  const machine = names[0]!;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(machine))
    throw new Error("The primary machine name is invalid.");
  return {
    kind: "remote",
    logicalKey: match.logicalKey,
    environmentId: input.environmentId,
    title: input.config.projectTitles[match.logicalKey] || "Untitled project",
    machine,
    host: `t3-${machine}`,
    primaryRoot: primary.path,
    replicaRoot: match.replica.path,
    cwd: pathApi(primary.path).join(primary.path, ...match.relative.split(/[\\/]/)),
  } as const;
}
