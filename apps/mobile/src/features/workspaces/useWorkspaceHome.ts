import { resolveProjectWorkspaceId } from "@t3tools/client-runtime/state/sidebar-workspaces";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope, HomeProjectSortOrder } from "../home/homeThreadList";
import {
  resolveThreadListV2Status,
  type ThreadListV2Item,
  type ThreadListV2ListItem,
  type ThreadListV2ThreadListItem,
} from "../threads/threadListV2";
import { useSidebarWorkspaces } from "./useSidebarWorkspaces";
import type { WorkspaceTileActivity } from "./WorkspaceChrome";
import { buildWorkspaceHomeItems, type WorkspaceHomeListItem } from "./workspaceNavigator";

/**
 * Home's workspace mode (fork feature): which projects the open workspace
 * holds, per-workspace activity for the tiles, and the desktop-like folder
 * list. Inactive (`workspace === null`) when no server has workspaces.
 */
export function useWorkspaceHome(input: {
  readonly projectScopes: ReadonlyArray<HomeProjectScope>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const workspaces = useSidebarWorkspaces();
  const { config, currentWorkspaceId, toggles } = workspaces;

  const scopeByProjectRef = useMemo(() => {
    const map = new Map<string, { scope: HomeProjectScope; workspaceId: string | null }>();
    if (config === null) return map;
    for (const scope of input.projectScopes) {
      const workspaceId = resolveProjectWorkspaceId(
        {
          projectKey: scope.key,
          workspaceRoots: scope.projects.map((project) => project.workspaceRoot),
        },
        config,
      );
      for (const ref of scope.projectRefs) {
        map.set(scopedProjectKey(ref.environmentId, ref.projectId), { scope, workspaceId });
      }
    }
    return map;
  }, [config, input.projectScopes]);

  const projectRefs = useMemo((): ReadonlyArray<ScopedProjectRef> | null => {
    if (config === null) return null;
    return input.projectScopes
      .filter((scope) => {
        const ref = scope.projectRefs[0];
        return (
          ref !== undefined &&
          scopeByProjectRef.get(scopedProjectKey(ref.environmentId, ref.projectId))?.workspaceId ===
            currentWorkspaceId
        );
      })
      .flatMap((scope) => scope.projectRefs);
  }, [config, currentWorkspaceId, input.projectScopes, scopeByProjectRef]);

  /** Narrows a project filter (or none) to the open workspace. */
  const restrictProjectRefs = useCallback(
    (scoped: ReadonlyArray<ScopedProjectRef> | null): ReadonlyArray<ScopedProjectRef> | null => {
      if (projectRefs === null) return scoped;
      if (scoped === null) return projectRefs;
      const inWorkspace = new Set(
        projectRefs.map((ref) => scopedProjectKey(ref.environmentId, ref.projectId)),
      );
      return scoped.filter((ref) =>
        inWorkspace.has(scopedProjectKey(ref.environmentId, ref.projectId)),
      );
    },
    [projectRefs],
  );

  const activity = useMemo(() => {
    const map = new Map<string, { attention: number; working: number }>();
    for (const thread of input.threads) {
      if (thread.archivedAt !== null) continue;
      const workspaceId = scopeByProjectRef.get(
        scopedProjectKey(thread.environmentId, thread.projectId),
      )?.workspaceId;
      if (!workspaceId) continue;
      const status = resolveThreadListV2Status(thread);
      const entry = map.get(workspaceId) ?? { attention: 0, working: 0 };
      if (status === "approval" || status === "input") entry.attention += 1;
      else if (status === "working") entry.working += 1;
      map.set(workspaceId, entry);
    }
    return map as ReadonlyMap<string, WorkspaceTileActivity>;
  }, [input.threads, scopeByProjectRef]);

  const folders = useMemo(
    () =>
      input.projectScopes.flatMap((scope) => {
        const ref = scope.projectRefs[0];
        if (
          ref === undefined ||
          scopeByProjectRef.get(scopedProjectKey(ref.environmentId, ref.projectId))?.workspaceId !==
            currentWorkspaceId
        ) {
          return [];
        }
        return [
          {
            projectKey: scope.key,
            title: scope.title,
            project: scope.representative,
            projectCreatedAt: scope.representative.createdAt ?? null,
            memberKeys: scope.projectRefs.map((member) =>
              scopedProjectKey(member.environmentId, member.projectId),
            ),
          },
        ];
      }),
    [currentWorkspaceId, input.projectScopes, scopeByProjectRef],
  );

  /** Home's rows: the folder list, or upstream's flat list while searching. */
  const buildItems = useCallback(
    (list: {
      readonly base: ReadonlyArray<ThreadListV2ListItem>;
      readonly searching: boolean;
      readonly sortOrder: HomeProjectSortOrder;
      readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
      readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
      readonly queuedThreadKeys: ReadonlySet<string>;
      readonly selectedThreadKey: string | null;
      readonly toRow: (item: ThreadListV2Item) => ThreadListV2ThreadListItem;
    }): ReadonlyArray<WorkspaceHomeListItem> => {
      if (config === null || currentWorkspaceId === null || list.searching) return list.base;
      // Queued new threads stay on top, as in upstream's list.
      const pending = list.base.filter((item) => item.type === "v2-pending");
      return [
        ...pending,
        ...buildWorkspaceHomeItems({
          workspaceId: currentWorkspaceId,
          folders,
          threads: input.threads,
          quietAfterDays: config.quietAfterDays,
          alwaysShow: new Set(config.alwaysShow),
          toggles,
          sortOrder: list.sortOrder,
          settlementEnvironmentIds: list.settlementEnvironmentIds,
          snoozeEnvironmentIds: list.snoozeEnvironmentIds,
          queuedThreadKeys: list.queuedThreadKeys,
          selectedThreadKey: list.selectedThreadKey,
          now: Date.now(),
          toRow: list.toRow,
        }),
      ];
    },
    [config, currentWorkspaceId, folders, input.threads, toggles],
  );

  const workspace =
    config?.workspaces.find((candidate) => candidate.id === currentWorkspaceId) ?? null;
  return { ...workspaces, workspace, restrictProjectRefs, activity, buildItems } as const;
}
