import { resolveAlias } from "./resolveAlias.ts";
import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

export function threadProjectTarget(
  config: SidebarWorkspacesConfig,
  sourceEnvironmentId: string,
  target: {
    readonly environmentId: string;
    readonly projectId?: string | undefined;
    readonly logicalKey?: string | undefined;
  },
) {
  let key =
    target.logicalKey ??
    Object.keys(config.projectMounts)
      .sort()
      .find((key) =>
        config.projectMounts[key]?.some(
          (rep) => rep.environmentId === target.environmentId && rep.projectId === target.projectId,
        ),
      );
  if (key !== undefined) key = resolveAlias(config.projectAliases, key);
  const local = key
    ? config.projectMounts[key]?.find((rep) => rep.environmentId === sourceEnvironmentId)
    : undefined;
  return { logicalKey: key, local };
}
