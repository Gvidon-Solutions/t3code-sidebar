import type { SidebarWorkspacesConfig } from "@t3tools/contracts";
import { machineTag } from "@t3tools/client-runtime/state/mesh-layout";

export function mobileMoveProjectLabel(
  project: { readonly title: string; readonly environmentId: string; readonly isScratch?: boolean },
  config: SidebarWorkspacesConfig,
): string {
  return `${project.isScratch ? "No project" : project.title} · ${machineTag(config, project.environmentId)}`;
}
