import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

export function mobileMoveProjectLabel(
  project: { readonly title: string; readonly environmentId: string; readonly isScratch?: boolean },
  config: SidebarWorkspacesConfig,
): string {
  return `${project.isScratch ? "No project" : project.title} · ${config.machines[project.environmentId]?.title ?? config.machines[project.environmentId]?.label ?? "This machine"}`;
}
