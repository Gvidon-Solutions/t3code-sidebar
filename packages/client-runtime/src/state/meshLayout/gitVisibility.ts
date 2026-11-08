import type { SidebarWorkspacesConfig } from "@t3tools/contracts";
import { replicaExecutionLabel } from "./replicas.ts";

/**
 * Hide git while a mesh layout loads or on a lite replica: a replica has no
 * `.git`, so offering Initialize Git there would create one by mistake. Without
 * a mesh every folder is an ordinary project and git shows.
 */
export function hidesGitControls(input: {
  readonly config: SidebarWorkspacesConfig | null;
  readonly environmentId: string;
  readonly projectId: string;
  readonly projectEnvironmentId?: string | undefined;
  /** A mesh-capable source exists, but its first layout snapshot has not arrived. */
  readonly layoutLoading: boolean;
}): boolean {
  if (input.config === null) return input.layoutLoading;
  return (
    replicaExecutionLabel(
      input.config,
      input.environmentId,
      input.projectId,
      input.projectEnvironmentId,
    ) !== null
  );
}
