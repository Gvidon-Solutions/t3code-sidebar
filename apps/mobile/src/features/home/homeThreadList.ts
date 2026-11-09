import { buildProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { offlineLogicalProjects } from "@t3tools/client-runtime/state/mesh-layout";
import { resolveProjectWorkspaceIds } from "@t3tools/client-runtime/state/sidebar-workspaces";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  getThreadSortTimestamp,
  toSortableTimestamp,
} from "@t3tools/client-runtime/state/thread-sort";
import type {
  EnvironmentId,
  ScopedProjectRef,
  SidebarProjectGroupingMode,
  SidebarProjectSortOrder,
  SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";

export type HomeProjectSortOrder = Exclude<SidebarProjectSortOrder, "manual">;

export function shouldShowHomeEmptyState(
  hasThreads: boolean,
  items: ReadonlyArray<{ readonly type: string }>,
): boolean {
  return !hasThreads && !items.some((item) => item.type === "ws-folder");
}

/**
 * Android draws its own full-height empty surface. It must also account for
 * workspace rows (folders, shelf rows) that are not thread items, or a
 * workspace with projects but no visible thread rows reads as empty.
 */
export function shouldShowAndroidHomeEmptyState(
  threadItemCount: number,
  items: ReadonlyArray<unknown>,
): boolean {
  return threadItemCount === 0 && items.length === 0;
}

export interface HomeProjectScope {
  /** T3 Mesh (fork): only reachable on a machine this client is not connected to. */
  readonly meshOffline?: {
    readonly environmentId: string;
    readonly tag: string;
    readonly state: string | null;
  };
  readonly key: string;
  readonly title: string;
  readonly representative: EnvironmentProject;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
  readonly pinned: boolean;
  readonly archived: boolean;
}

export function homeProjectWorkspaceIds(
  scope: HomeProjectScope,
  config: SidebarWorkspacesConfig,
  isScratch: boolean,
): ReadonlyArray<string> {
  return resolveProjectWorkspaceIds(
    {
      projectKey: scope.key,
      workspaceRoots: scope.projects.map((project) => project.workspaceRoot),
      isScratch,
    },
    config,
  );
}

function getProjectSortTimestamp(
  project: EnvironmentProject,
  sortOrder: HomeProjectSortOrder,
): number {
  return sortOrder === "created_at"
    ? (toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY)
    : (toSortableTimestamp(project.updatedAt) ??
        toSortableTimestamp(project.createdAt) ??
        Number.NEGATIVE_INFINITY);
}

export function buildHomeProjectScopes(input: {
  readonly layout?: SidebarWorkspacesConfig;
  readonly connectedEnvironmentIds?: ReadonlySet<string>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentId: EnvironmentId | null;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}): ReadonlyArray<HomeProjectScope> {
  const projects = input.projects.filter(
    (project) => input.environmentId === null || project.environmentId === input.environmentId,
  );
  const scopes: HomeProjectScope[] = buildProjectGroups({
    projects,
    groupScratchProjects: true,
    settings: {
      sidebarProjectGroupingMode: input.projectGroupingMode,
      sidebarProjectGroupingOverrides: {},
    },
    ...(input.layout === undefined ? {} : { layout: input.layout }),
  }).map((group) => {
    return {
      key: group.key,
      title: group.label,
      representative: group.representative,
      projects: group.members.map((member) => member.project),
      projectRefs: group.memberProjectRefs,
      pinned: group.pinned,
      archived: group.archived,
    };
  });
  if (input.layout === undefined || input.connectedEnvironmentIds === undefined) return scopes;
  const existing = new Set(scopes.map((scope) => scope.key));
  const offline = offlineLogicalProjects(input.layout, input.connectedEnvironmentIds)
    .filter((entry) => {
      if (existing.has(entry.logicalKey)) return false;
      existing.add(entry.logicalKey);
      return true;
    })
    .map((entry): HomeProjectScope => {
      const title =
        input.layout?.projectTitles[entry.logicalKey] ??
        entry.path.split(/[\\/]/).filter(Boolean).at(-1) ??
        entry.logicalKey;
      const project = {
        id: `mesh:${entry.logicalKey}:${entry.environmentId}`,
        environmentId: entry.environmentId,
        title,
        workspaceRoot: entry.path,
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: entry.updatedAt ?? "1970-01-01T00:00:00.000Z",
        updatedAt: entry.updatedAt ?? "1970-01-01T00:00:00.000Z",
      } as unknown as EnvironmentProject;
      return {
        key: entry.logicalKey,
        title,
        representative: project,
        projects: [project],
        projectRefs: [],
        pinned: false,
        archived: false,
        meshOffline: {
          environmentId: entry.environmentId,
          tag: entry.tag,
          state: entry.state,
        },
      };
    });
  return [...scopes, ...offline];
}

export function findHomeProjectScope(
  scopes: ReadonlyArray<HomeProjectScope>,
  key: string | null,
): HomeProjectScope | null {
  if (key === null) {
    return null;
  }
  return (
    scopes.find((scope) => scope.key === key) ??
    scopes.find((scope) =>
      scope.projectRefs.some(
        (projectRef) => scopedProjectKey(projectRef.environmentId, projectRef.projectId) === key,
      ),
    ) ??
    null
  );
}

export function sortHomeProjectScopes(input: {
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly projectSortOrder: HomeProjectSortOrder;
}): ReadonlyArray<HomeProjectScope> {
  const scopeKeyByProjectRef = new Map(
    input.scopes.flatMap((scope) =>
      scope.projectRefs.map(
        (projectRef) =>
          [scopedProjectKey(projectRef.environmentId, projectRef.projectId), scope.key] as const,
      ),
    ),
  );
  const latestActivityByScope = new Map<string, number>();
  const recordActivity = (scopeKey: string | undefined, timestamp: number) => {
    if (!scopeKey || !Number.isFinite(timestamp)) return;
    latestActivityByScope.set(
      scopeKey,
      Math.max(latestActivityByScope.get(scopeKey) ?? Number.NEGATIVE_INFINITY, timestamp),
    );
  };

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    recordActivity(
      scopeKeyByProjectRef.get(scopedProjectKey(thread.environmentId, thread.projectId)),
      getThreadSortTimestamp(thread, input.projectSortOrder),
    );
  }
  for (const pendingTask of input.pendingTasks) {
    recordActivity(
      scopeKeyByProjectRef.get(scopedProjectKey(pendingTask.environmentId, pendingTask.projectId)),
      Date.parse(pendingTask.createdAt),
    );
  }

  return Arr.sort(
    input.scopes,
    Order.mapInput(
      Order.Struct({
        timestamp: Order.flip(Order.Number),
        title: Order.String,
        key: Order.String,
      }),
      (scope: HomeProjectScope) => ({
        timestamp:
          latestActivityByScope.get(scope.key) ??
          Math.max(
            ...scope.projects.map((project) =>
              getProjectSortTimestamp(project, input.projectSortOrder),
            ),
          ),
        title: scope.title,
        key: scope.key,
      }),
    ),
  );
}
