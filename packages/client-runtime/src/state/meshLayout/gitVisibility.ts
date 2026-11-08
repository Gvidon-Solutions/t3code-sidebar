import type { SidebarWorkspacesConfig } from "@t3tools/contracts";
import { replicaExecutionLabel } from "./replicas.ts";

/**
 * Whether git controls must stay hidden for this thread's folder. Before the
 * layout loads we cannot prove the folder is a primary, so hide them: a lite
 * replica has no `.git`, and offering Initialize Git there would create one by
 * mistake. Once the layout says primary, the normal git rows return.
 */
export function hidesGitControls(
  config: SidebarWorkspacesConfig | null,
  environmentId: string,
  projectId: string,
  projectEnvironmentId?: string,
): boolean {
  if (config === null) return true;
  return replicaExecutionLabel(config, environmentId, projectId, projectEnvironmentId) !== null;
}
