import {
  type ClientSettings,
  type EnvironmentId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useClientSettings } from "../hooks/useSettings";
import { useMeshLayoutOptional } from "../hooks/useMeshLayout";
import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import { getProjectOrderKey } from "@t3tools/client-runtime/state/project-grouping";
import { useProjects, useVisibleThreadShells } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { orderItemsByPreferredIds, sortLogicalProjectsForSidebar } from "./Sidebar.logic";

// Each helper reads its own source hook so the compiler caches the derived value on that
// source. Taking the source as an argument instead leaves the helper hook-free, and the
// compiler then treats it as a plain function and caches nothing.
export interface CommandPaletteProjectLocation {
  readonly label: string | null;
  readonly machine: ReturnType<typeof resolveEnvironmentMachineKind>;
}

export function useEnvironmentLookups() {
  const { environments } = useEnvironments();
  const mesh = useMeshLayoutOptional();
  const config = mesh.config ?? { machines: {} };
  // Machine names come from the mesh config, never the OS hostname or "Local".
  const labelOf = (environmentId: EnvironmentId, fallback: string) => {
    const display = machineDisplayOf(config, String(environmentId), "");
    if (display.label !== "Unnamed machine") return display.label;
    // No configured name: a local-only folder shows paths, not a hostname or "Local".
    const local =
      environments.find((entry) => entry.environmentId === environmentId)?.entry.target._tag ===
        "PrimaryConnectionTarget" ||
      isDesktopLocalConnectionTarget(
        environments.find((entry) => entry.environmentId === environmentId)?.entry.target as never,
      );
    return local ? null : fallback.trim() || null;
  };
  const environmentLabelById = new Map(
    environments.flatMap((environment) => {
      const label = labelOf(environment.environmentId, environment.label);
      return label === null ? [] : [[environment.environmentId, label] as const];
    }),
  );
  const projectEnvironmentLocationById = new Map(
    environments.map((environment) => [
      environment.environmentId,
      {
        label: labelOf(environment.environmentId, environment.label),
        machine: resolveEnvironmentMachineKind(environment.serverConfig),
      } as const,
    ]),
  );
  return { environmentLabelById, projectEnvironmentLocationById };
}

export function useProjectLookups() {
  const projects = useProjects();
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  return { projectByKey };
}

export const selectCommandPaletteClientSettings = (settings: ClientSettings) => ({
  sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
  sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  sidebarProjectSortOrder: settings.sidebarProjectSortOrder,
  sidebarThreadSortOrder: settings.sidebarThreadSortOrder,
});

export function useSortedProjectGroups(environmentLabelById: ReadonlyMap<EnvironmentId, string>) {
  const projects = useProjects();
  const threads = useVisibleThreadShells();
  const { environments } = useEnvironments();
  const mesh = useMeshLayoutOptional();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const clientSettings = useClientSettings(selectCommandPaletteClientSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = {
    sidebarProjectGroupingMode: clientSettings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: clientSettings.sidebarProjectGroupingOverrides,
  };
  const orderedProjects = orderItemsByPreferredIds({
    items: projects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  const unsortedProjectGroups = buildSidebarProjectSnapshots({
    ...(mesh.config === null ? {} : { layout: mesh.config }),
    connectedEnvironmentIds: new Set(
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => String(environment.environmentId)),
    ),
    projects: clientSettings.sidebarProjectSortOrder === "manual" ? orderedProjects : projects,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
  });
  return sortLogicalProjectsForSidebar(
    unsortedProjectGroups,
    threads,
    clientSettings.sidebarProjectSortOrder,
  );
}
