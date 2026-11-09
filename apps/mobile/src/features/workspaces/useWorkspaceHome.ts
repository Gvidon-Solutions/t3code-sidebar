import { useAtomCommand } from "../../state/use-atom-command";
import { projectEnvironment } from "../../state/projects";
import { useAtomValue } from "@effect/atom-react";
import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import {
  machineTag,
  renameLogicalProject,
  suggestMerges,
} from "@t3tools/client-runtime/state/mesh-layout";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  projectFoldModeOf,
  projectOrderOf,
  resolveProjectWorkspaceIds,
  sortWorkspaceProjects,
  type WorkspaceProjectIdentity,
} from "@t3tools/client-runtime/state/sidebar-workspaces";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { useServerConfigs } from "../../state/entities";
import { offlineMeshEnvironmentIds } from "@t3tools/client-runtime/state/mesh-machines";
import { useMeshOverview } from "./useMeshOverview";
import { useReplicaStatuses } from "../../state/meshReplicas";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { homeProjectWorkspaceIds, type HomeProjectScope } from "../home/homeThreadList";
import {
  resolveThreadListV2Status,
  type ThreadListV2Item,
  type ThreadListV2ListItem,
  type ThreadListV2ThreadListItem,
} from "../threads/threadListV2";
import { useLiveVoiceKey } from "../voice-mode/useVoiceMode";
import { agentThreadShellsAtom } from "./agentThreadShells";
import { mobilePendingReplicaItems } from "./replicas.logic";
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
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: true });
  const {
    config,
    currentWorkspaceId,
    toggles,
    toggleProjectIn: toggleProjectInWorkspace,
  } = workspaces;
  const serverConfigs = useServerConfigs();
  const replicaStatuses = useReplicaStatuses();
  const { machines } = useMeshOverview({ config });
  const offlineMachines = useMemo(
    () => machines.filter((machine) => machine.network?.state === "offline"),
    [machines],
  );
  const offlineEnvironmentIds = useMemo(
    () => offlineMeshEnvironmentIds(offlineMachines),
    [offlineMachines],
  );
  const connectedEnvironmentIds = useAtomValue(connectedEnvironmentIdsAtom);
  const resolveMachineDisplay = useCallback(
    (environmentId: EnvironmentId) =>
      machineDisplayOf(
        config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
        environmentId,
        serverConfigs.get(environmentId)?.environment.label ?? environmentId,
      ),
    [config, serverConfigs],
  );
  const voiceThreadKey = useLiveVoiceKey();
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
      return config === null ? [] : homeProjectWorkspaceIds(scope, config, isScratchScope(scope));
    },
    [config, isScratchScope],
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
        project: isScratchScope(scope)
          ? (scope.projects.find(
              (project) => project.environmentId === connectedEnvironmentIds[0],
            ) ?? scope.representative)
          : scope.representative,
        projectCreatedAt: scope.representative.createdAt ?? null,
        memberKeys: scope.projectRefs.map((member) =>
          scopedProjectKey(member.environmentId, member.projectId),
        ),
        environmentIds: scope.projectRefs.map((member) => member.environmentId),
        isScratch: isScratchScope(scope),
        workspaceIds: workspaceIdsOf(scope),
        ...(scope.meshOffline === undefined ? {} : { meshOffline: scope.meshOffline }),
        pending: mobilePendingReplicaItems(
          config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
          replicaStatuses,
          scope.key,
        ),
      });
    }
    return { folders: own, otherFolders: other };
  }, [
    config,
    input.projectScopes,
    connectedEnvironmentIds,
    isInCurrentWorkspace,
    isScratchScope,
    replicaStatuses,
    workspaceIdsOf,
  ]);

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
      // Queued new threads stay on top, as in upstream's list, under a voice conversation.
      const pending = list.base.filter((item) => item.type === "v2-pending");
      const [first, ...rest] = buildWorkspaceHomeItems({
        config,
        liveStatuses: replicaStatuses,
        workspaceId: currentWorkspaceId,
        folders,
        otherFolders,
        threads: homeThreads,
        quietAfterDays: config.quietAfterDays,
        foldModeOf: (projectKey) => projectFoldModeOf(config, currentWorkspaceId, projectKey),
        toggles,
        projectOrder: projectOrderOf(config, currentWorkspaceId),
        settlementEnvironmentIds: list.settlementEnvironmentIds,
        snoozeEnvironmentIds: list.snoozeEnvironmentIds,
        queuedThreadKeys: list.queuedThreadKeys,
        selectedThreadKey: list.selectedThreadKey,
        voiceThreadKey,
        // Offline machines stay dimmed in the strip; a registered config is not a connection.
        connectedEnvironmentIds: [...new Set(connectedEnvironmentIds)],
        offlineEnvironmentIds,
        offlineMachines,
        resolveMachineDisplay,
        now: Date.now(),
        toRow: list.toRow,
      });
      if (first === undefined) return pending;
      return first.type === "ws-thread" && first.voice === true
        ? [first, ...pending, ...rest]
        : [...pending, first, ...rest];
    },
    [
      config,
      currentWorkspaceId,
      folders,
      homeThreads,
      replicaStatuses,
      otherFolders,
      toggles,
      voiceThreadKey,
      connectedEnvironmentIds,
      offlineEnvironmentIds,
      offlineMachines,
      resolveMachineDisplay,
    ],
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
            foldModeOf: (projectKey) => projectFoldModeOf(config, currentWorkspaceId, projectKey),
            projectOrder: projectOrderOf(config, currentWorkspaceId),
            now: Date.now(),
          }),
    [config, currentWorkspaceId, folders, input.threads],
  );

  const scopeKeyByProjectRef = useMemo(() => {
    const map = new Map<string, string>();
    for (const scope of input.projectScopes)
      for (const ref of scope.projectRefs)
        map.set(scopedProjectKey(ref.environmentId, ref.projectId), scope.key);
    return map;
  }, [input.projectScopes]);

  const suggestionsByScope = useMemo(() => {
    const suggestions = new Map<string, { readonly key: string; readonly tag: string }[]>();
    if (config === null) return suggestions;
    for (const group of suggestMerges(input.projectScopes.flatMap((scope) => scope.projects))) {
      const keys = new Set(
        group.flatMap((project) => {
          const key = scopeKeyByProjectRef.get(scopedProjectKey(project.environmentId, project.id));
          return key === undefined ? [] : [key];
        }),
      );
      for (const key of keys) {
        const scope = input.projectScopes.find((candidate) => candidate.key === key);
        if (!scope) continue;
        for (const otherKey of keys) {
          if (otherKey === key) continue;
          const other = input.projectScopes.find((candidate) => candidate.key === otherKey);
          if (!other) continue;
          const tag = machineTag(config, other.representative.environmentId, null);
          const list = suggestions.get(key) ?? [];
          if (!list.some((entry) => entry.key === otherKey)) list.push({ key: otherKey, tag });
          suggestions.set(key, list);
        }
      }
    }
    return suggestions;
  }, [config, input.projectScopes, scopeKeyByProjectRef]);

  const meshActionsFor = useCallback(
    (projectKey: string) => {
      if (config === null) return undefined;
      const scope = input.projectScopes.find((candidate) => candidate.key === projectKey);
      if (!scope) return undefined;
      return {
        mergeTargets: input.projectScopes
          .filter((candidate) => candidate.key !== projectKey)
          .map((candidate) => ({ key: candidate.key, label: candidate.title })),
        splitTargets: scope.projects.map((project) => ({
          environmentId: project.environmentId,
          label: machineTag(config, project.environmentId, null),
        })),
        canSplit:
          scope.projects.length > 1 || Object.values(config.projectAliases).includes(projectKey),
        suggestions: suggestionsByScope.get(projectKey) ?? [],
        onRename: (title: string) => {
          workspaces.updateConfig((current) =>
            renameLogicalProject(current, projectKey, title, scope.projects),
          );
          for (const project of scope.projects)
            void updateProject({
              environmentId: project.environmentId,
              input: { projectId: project.id, title },
            });
        },
        onMerge: (into: string) => workspaces.edit.mergeProject(projectKey, into),
        onSplit: (environmentId: string) =>
          workspaces.edit.splitProject(
            projectKey,
            environmentId,
            `${projectKey}~${environmentId}`,
            scope.projects.find((project) => project.environmentId === environmentId),
          ),
      };
    },
    [config, input.projectScopes, suggestionsByScope, workspaces, updateProject],
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
    meshActionsFor,
  } as const;
}
