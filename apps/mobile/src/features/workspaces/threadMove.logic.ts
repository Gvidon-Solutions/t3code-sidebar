import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

export function mobileMoveProjectLabel(
  project: { readonly title: string; readonly environmentId: string; readonly isScratch?: boolean },
  config: SidebarWorkspacesConfig,
): string {
  return `${project.isScratch ? "No project" : project.title} · ${machineDisplayOf(config, project.environmentId, "").label}`;
}
