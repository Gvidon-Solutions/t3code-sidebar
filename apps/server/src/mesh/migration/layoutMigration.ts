import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import {
  adoptLegacy,
  diff,
  migrateLogicalProjectIds,
  type MeshLayoutDocument,
} from "@t3tools/shared/meshLayout";
export function migrateLayout(document: MeshLayoutDocument): MeshLayoutDocument {
  const combined = migrateLogicalProjectIds(document);
  return Object.entries(combined).some(
    ([key, entry]) => key.startsWith("ws/") && entry.h.startsWith("0000000000000."),
  )
    ? adoptLegacy(DEFAULT_SIDEBAR_WORKSPACES_CONFIG, combined)
    : combined;
}
export function legacySettingsDiff(
  before: SidebarWorkspacesConfig,
  after: SidebarWorkspacesConfig,
  document: MeshLayoutDocument,
  hlc: string,
): MeshLayoutDocument {
  return diff(
    before,
    {
      ...after,
      ...(Object.keys(after.projectTitles ?? {}).length === 0 &&
      Object.keys(before.projectTitles).length > 0
        ? { projectTitles: before.projectTitles }
        : {}),
    },
    document,
    hlc,
  );
}
