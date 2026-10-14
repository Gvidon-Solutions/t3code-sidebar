import { useAtomValue } from "@effect/atom-react";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  projectOrderOf,
  resolveProjectWorkspaceIds,
  sortWorkspaceProjects,
  type WorkspaceProjectIdentity,
} from "@t3tools/client-runtime/state/sidebar-workspaces";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { useServerConfigs } from "../../state/entities";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  resolveThreadListV2Status,
  type ThreadListV2Item,
  type ThreadListV2ListItem,
  type ThreadListV2ThreadListItem,
} from "../threads/threadListV2";
import { agentThreadShellsAtom } from "./agentThreadShells";
import { useSidebarWorkspaces } from "./useSidebarWorkspaces";
import type { WorkspaceTileActivity } from "./WorkspaceChrome";
import {
  arrangeWorkspaceFolders,
  buildWorkspaceHomeItems,
  type WorkspaceFolderInput,
  type WorkspaceHomeListItem,
} from "./workspaceNavigator";

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
  const {
    config,
    currentWorkspaceId,
    toggles,
    toggleProjectIn: toggleProjectInWorkspace,
  } = workspaces;
  const serverConfigs = useServerConfigs();
  // Subagents, which the navigation list leaves out, hang under their thread.
  const agentThreads = useAtomValue(agentThreadShellsAtom);
  const homeThreads = useMemo(
    () => (agentThreads.length === 0 ? input.threads : [...input.threads, ...agentThreads]),
    [agentThreads, input.threads],
  );

  const isScratchScope = useCallback(
    (scope: HomeProjectScope) =>
      scope.projects.some((project) =>
        isScratchProject(project, serverConfigs.get(project.environmentId)?.scratchWorkspaceRoot),
      ),
    [serverConfigs],
  );

  const identityOf = useCallback(
    (scope: HomeProjectScope): WorkspaceProjectIdentity => ({
      projectKey: scope.key,
      workspaceRoots: scope.projects.map((project) => project.workspaceRoot),
      isScratch: isScratchScope(scope),
    }),
    [isScratchScope],
  );

  // A project can show in several workspaces ("No project": all, until placed).
  const scopeByProjectRef = useMemo(() => {
    const map = new Map<string, { scope: HomeProjectScope; workspaceIds: ReadonlyArray<string> }>();
    if (config === null) return map;
    for (const scope of input.projectScopes) {
      const workspaceIds = resolveProjectWorkspaceIds(identityOf(scope), config);
      for (const ref of scope.projectRefs) {
        map.set(scopedProjectKey(ref.environmentId, ref.projectId), { scope, workspaceIds });
      }
    }
    return map;
  }, [config, identityOf, input.projectScopes]);

  const workspaceIdsOf = useCallback(
    (scope: HomeProjectScope): ReadonlyArray<string> => {
      const ref = scope.projectRefs[0];
      if (ref === undefined) return [];
      return (
        scopeByProjectRef.get(scopedProjectKey(ref.environmentId, ref.projectId))?.workspaceIds ??
        []
      );
    },
    [scopeByProjectRef],
  );

  /** Whether a project's folder shows in the open workspace. */
  const isInCurrentWorkspace = useCallback(
    (scope: HomeProjectScope) =>
      currentWorkspaceId !== null && workspaceIdsOf(scope).includes(currentWorkspaceId),
    [currentWorkspaceId, workspaceIdsOf],
  );

  const projectRefs = useMemo((): ReadonlyArray<ScopedProjectRef> | null => {
    if (config === null) return null;
    return input.projectScopes.filter(isInCurrentWorkspace).flatMap((scope) => scope.projectRefs);
  }, [config, input.projectScopes, isInCurrentWorkspace]);

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
      const workspaceIds = scopeByProjectRef.get(
        scopedProjectKey(thread.environmentId, thread.projectId),
      )?.workspaceIds;
      if (!workspaceIds) continue;
      const status = resolveThreadListV2Status(thread);
      for (const workspaceId of workspaceIds) {
        const entry = map.get(workspaceId) ?? { attention: 0, working: 0 };
        if (status === "approval" || status === "input") entry.attention += 1;
        else if (status === "working") entry.working += 1;
        map.set(workspaceId, entry);
      }
    }
    return map as ReadonlyMap<string, WorkspaceTileActivity>;
  }, [input.threads, scopeByProjectRef]);

  // Pinned threads show in every workspace, so the other workspaces' folders
  // come along for their pinned threads only.
  const { folders, otherFolders } = useMemo(() => {
    const own: WorkspaceFolderInput[] = [];
    const other: WorkspaceFolderInput[] = [];
    for (const scope of input.projectScopes) {
      (isInCurrentWorkspace(scope) ? own : other).push({
        projectKey: scope.key,
        title: scope.title,
        project: scope.representative,
        projectCreatedAt: scope.representative.createdAt ?? null,
        memberKeys: scope.projectRefs.map((member) =>
          scopedProjectKey(member.environmentId, member.projectId),
        ),
        isScratch: isScratchScope(scope),
        workspaceIds: workspaceIdsOf(scope),
      });
    }
    return { folders: own, otherFolders: other };
  }, [input.projectScopes, isInCurrentWorkspace, isScratchScope, workspaceIdsOf]);

  /** "Show in workspaces" from a folder's menu. */
  const toggleProjectIn = useCallback(
    (projectKey: string, workspaceId: string) => {
      const scope = input.projectScopes.find((candidate) => candidate.key === projectKey);
      if (!scope || config === null) return;
      // A workspace's projects as it shows them, so the project lands on top there.
      const sequenceOf = (id: string) =>
        sortWorkspaceProjects(
          input.projectScopes.filter(
            (candidate) => !isScratchScope(candidate) && workspaceIdsOf(candidate).includes(id),
          ),
          projectOrderOf(config, id),
          (candidate) => ({
            projectKey: candidate.key,
            createdAt: candidate.representative.createdAt ?? null,
          }),
        ).map((candidate) => candidate.key);
      toggleProjectInWorkspace(identityOf(scope), workspaceId, sequenceOf);
    },
    [
      config,
      identityOf,
      input.projectScopes,
      isScratchScope,
      toggleProjectInWorkspace,
      workspaceIdsOf,
    ],
  );

  /** Home's rows: the folder list, or upstream's flat list while searching. */
  const buildItems = useCallback(
    (list: {
      readonly base: ReadonlyArray<ThreadListV2ListItem>;
      readonly searching: boolean;
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
          otherFolders,
          threads: homeThreads,
          quietAfterDays: config.quietAfterDays,
          alwaysShow: new Set(config.alwaysShow),
          toggles,
          projectOrder: projectOrderOf(config, currentWorkspaceId),
          settlementEnvironmentIds: list.settlementEnvironmentIds,
          snoozeEnvironmentIds: list.snoozeEnvironmentIds,
          queuedThreadKeys: list.queuedThreadKeys,
          selectedThreadKey: list.selectedThreadKey,
          now: Date.now(),
          toRow: list.toRow,
        }),
      ];
    },
    [config, currentWorkspaceId, folders, homeThreads, otherFolders, toggles],
  );

  /** The open workspace's folders for the long-press drag, read when a drag starts. */
  const arrangeFolders = useCallback(
    () =>
      config === null || currentWorkspaceId === null
        ? []
        : arrangeWorkspaceFolders({
            folders,
            threads: input.threads,
            quietAfterDays: config.quietAfterDays,
            alwaysShow: new Set(config.alwaysShow),
            projectOrder: projectOrderOf(config, currentWorkspaceId),
            now: Date.now(),
          }),
    [config, currentWorkspaceId, folders, input.threads],
  );

  const workspace =
    config?.workspaces.find((candidate) => candidate.id === currentWorkspaceId) ?? null;
  return {
    ...workspaces,
    toggleProjectIn,
    workspace,
    restrictProjectRefs,
    activity,
    buildItems,
    arrangeFolders,
  } as const;
}
