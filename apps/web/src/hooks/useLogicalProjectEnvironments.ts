import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, type ProjectId, resolveEnvironmentMachineKind } from "@t3tools/contracts";

import type { EnvironmentOption } from "../components/BranchToolbar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import { resolveLogicalProjectKey } from "@t3tools/client-runtime/state/mesh-layout";
import { useMeshLayout } from "./useMeshLayout";
import { useProjects } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useClientSettings } from "./useSettings";

export function useLogicalProjectEnvironments(
  activeProject: EnvironmentProject | null,
  scratchDraft: boolean,
): readonly EnvironmentOption[] {
  const { environments } = useEnvironments();
  const mesh = useMeshLayout();
  const allProjects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);

  if (!activeProject) return [];
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const envs: EnvironmentOption[] = [];
  const pushEnvironment = (environmentId: EnvironmentId, projectId: ProjectId | null) => {
    const environment = environmentById.get(environmentId) ?? null;
    envs.push({
      environmentId,
      projectId,
      label: mesh.config
        ? machineDisplayOf(mesh.config, environmentId, environment?.label ?? "Machine").label
        : (environment?.label ?? "Machine"),
      connected: environment?.connection.phase === "connected",
      supportsMesh: environment?.serverConfig?.environment.capabilities.replicas === true,
      isPrimary: environmentId === primaryEnvironmentId,
      machine: resolveEnvironmentMachineKind(environment?.serverConfig ?? null),
    });
  };
  if (scratchDraft) {
    for (const environment of environments) {
      const scratchRoot = availableScratchWorkspaceRoot(
        environment.connection.phase,
        environment.serverConfig,
      );
      if (scratchRoot === null && environment.environmentId !== activeProject.environmentId)
        continue;
      const scratchProject =
        environment.environmentId === activeProject.environmentId
          ? activeProject
          : allProjects.find(
              (p) =>
                p.environmentId === environment.environmentId && isScratchProject(p, scratchRoot),
            );
      pushEnvironment(environment.environmentId, scratchProject?.id ?? null);
    }
  } else {
    const fallback = (project: EnvironmentProject) =>
      deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings);
    const keyOf = (project: EnvironmentProject) =>
      mesh.config ? resolveLogicalProjectKey(project, mesh.config, fallback) : fallback(project);
    const logicalKey = keyOf(activeProject);
    const seen = new Set<string>();
    for (const p of allProjects) {
      if (seen.has(p.environmentId)) continue;
      if (keyOf(p) !== logicalKey) continue;
      seen.add(p.environmentId);
      pushEnvironment(p.environmentId, p.id);
    }
    for (const environment of environments) {
      if (
        !seen.has(environment.environmentId) &&
        environment.serverConfig?.environment.capabilities.replicas
      ) {
        pushEnvironment(environment.environmentId, null);
      }
    }
  }
  for (const id of Object.keys(mesh.config?.machines ?? {})) {
    if (!envs.some((environment) => environment.environmentId === id))
      pushEnvironment(EnvironmentId.make(id), null);
  }
  envs.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return envs;
}
