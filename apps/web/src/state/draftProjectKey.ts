import type { SidebarWorkspacesConfig } from "@t3tools/contracts";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { resolveLogicalProjectKey } from "@t3tools/client-runtime/state/mesh-layout";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { readMeshLayoutConfigSnapshot } from "./meshLayoutConfig";

export type DraftProjectKeySource = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "title" | "workspaceRoot" | "repositoryIdentity" | "isScratch"
>;

export interface DraftLogicalKeyEntry {
  readonly draftId: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly logicalProjectKey: string;
}

/**
 * The one draft key: the mesh logical project when a snapshot exists, else the
 * project-grouping key. Every draft consumer uses this so one project never gets
 * two drafts.
 */
export function resolveDraftLogicalProjectKey<T extends DraftProjectKeySource>(
  project: T,
  groupingSettings: ProjectGroupingSettings,
  config: SidebarWorkspacesConfig | null = readMeshLayoutConfigSnapshot(),
): string {
  const fallback = deriveLogicalProjectKeyFromSettings(project, groupingSettings);
  return config === null ? fallback : resolveLogicalProjectKey(project, config, () => fallback);
}

/**
 * Drafts created before the mesh snapshot loaded carry the grouping key. Once the
 * snapshot arrives they must move to the mesh key instead of being duplicated by
 * the next "new thread".
 */
export function planDraftLogicalProjectKeyRekeys<T extends DraftProjectKeySource>(input: {
  readonly drafts: ReadonlyArray<DraftLogicalKeyEntry>;
  readonly projects: ReadonlyArray<T>;
  readonly config: SidebarWorkspacesConfig | null;
  readonly groupingSettings: ProjectGroupingSettings;
}): ReadonlyArray<{ readonly draftId: string; readonly logicalProjectKey: string }> {
  const config = input.config;
  if (config === null) return [];
  const projectByRef = new Map(
    input.projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  return input.drafts.flatMap((draft) => {
    const project = projectByRef.get(`${draft.environmentId}:${draft.projectId}`);
    if (project === undefined) return [];
    const fallback = deriveLogicalProjectKeyFromSettings(project, input.groupingSettings);
    // Only a draft still on the grouping key is stale. A key the person or a
    // merge chose on purpose is left alone.
    if (draft.logicalProjectKey !== fallback) return [];
    const next = resolveLogicalProjectKey(project, config, () => fallback);
    return next === draft.logicalProjectKey
      ? []
      : [{ draftId: draft.draftId, logicalProjectKey: next }];
  });
}
