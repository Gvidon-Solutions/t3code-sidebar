/**
 * Workspace sidebar (fork feature): workspace tiles at the bottom, the open
 * workspace's name on top, and its projects as folders of one-line threads.
 * Projects idle for a few days fold into "Quiet projects".
 *
 * It reuses the default sidebar's data and mutations (thread shells, project
 * grouping, useThreadActions, the thread action menu) and only owns layout and
 * workspace bookkeeping. The workspace config is a shared server setting.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type ContextMenuItem,
  type ScopedThreadRef,
  type SidebarWorkspace,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  EllipsisIcon,
  FolderPlusIcon,
  MessagesSquareIcon,
  PinIcon,
  SearchIcon,
  SquarePenIcon,
  XIcon,
  AlarmClockIcon,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { isCommandPaletteOpen, openCommandPalette } from "../../commandPaletteBus";
import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useNowMinute } from "../../hooks/useNowMinute";
import {
  useClientSettings,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { useThreadActions } from "../../hooks/useThreadActions";
import {
  resolveShortcutCommand,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { readLocalApi } from "../../localApi";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  resolveAdjacentThreadId,
  sortLogicalProjectsForSidebar,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
} from "../Sidebar.logic";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SidebarContent, SidebarInput, useSidebar } from "../ui/sidebar";
import {
  WORKSPACE_PROJECT_DRAG_TYPE,
  WorkspaceAvatar,
  WorkspaceDock,
  WorkspaceTitlebar,
  type WorkspaceTileEntry,
} from "./WorkspaceChrome";
import { WorkspaceThreadRow, type WorkspaceRowVariant } from "./WorkspaceThreadRow";
import { useWorkspaceViewStore } from "./workspaceViewStore";
import {
  EMPTY_WORKSPACE_ACTIVITY,
  isProjectQuiet,
  makeWorkspaceId,
  needsAttention,
  resolveProjectWorkspaceId,
  summarizeWorkspaceActivity,
  threadActivityMs,
  WORKSPACE_COLORS,
  workspaceColor,
} from "./workspaces.logic";

const FOLDER_PREVIEW_COUNT = 8;
const SETTLED_PAGE_COUNT = 10;
/** Stand-in until the user creates a workspace: everything lives here. */
const IMPLICIT_WORKSPACE: SidebarWorkspace = { id: "personal", name: "Personal" };

interface FolderModel {
  group: SidebarProjectSnapshot;
  workspaceId: string;
  label: string;
  isScratch: boolean;
  quiet: boolean;
  active: SidebarThreadSummary[];
  settled: SidebarThreadSummary[];
  all: SidebarThreadSummary[];
}

interface WorkspaceModel {
  workspace: SidebarWorkspace;
  folders: FolderModel[];
  pinned: SidebarThreadSummary[];
  snoozed: SidebarThreadSummary[];
  threads: SidebarThreadSummary[];
}

function threadKeyOf(thread: Pick<SidebarThreadSummary, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

async function reportFailure(
  title: string,
  run: () => Promise<AtomCommandResult<unknown, unknown>>,
): Promise<void> {
  const result = await run();
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    failureToast(title, squashAtomCommandFailure(result));
  }
}

export default function WorkspaceSidebar() {
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const storedConfig = usePrimarySettings((s) => s.sidebarWorkspaces);
  const updatePrimarySettings = useUpdatePrimarySettings();
  const lastVisitedById = useUiStateStore((s) => s.threadLastVisitedAtById);
  const nowMinute = useNowMinute();
  const now = Date.parse(nowMinute) || Date.now();

  const view = useWorkspaceViewStore();
  const { settleThread, unsettleThread, unsnoozeThread, pinThread, confirmAndUnpinThread } =
    useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();

  // ── Config ────────────────────────────────────────────────────────────
  const config: SidebarWorkspacesConfig = useMemo(() => {
    const base = storedConfig ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG;
    return base.workspaces.length > 0
      ? base
      : { ...base, workspaces: [IMPLICIT_WORKSPACE], defaultWorkspace: IMPLICIT_WORKSPACE.id };
  }, [storedConfig]);
  const configRef = useRef(config);
  configRef.current = config;
  const writeConfig = useCallback(
    (update: (current: SidebarWorkspacesConfig) => SidebarWorkspacesConfig) => {
      updatePrimarySettings({ sidebarWorkspaces: update(configRef.current) });
    },
    [updatePrimarySettings],
  );

  // ── Route ─────────────────────────────────────────────────────────────
  const routeTarget = useParams({ strict: false, select: resolveThreadRouteTarget });
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = useMemo(
    () => resolveActiveThreadRouteRef(routeTarget, routeDraftThread),
    [routeDraftThread, routeTarget],
  );
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeProjectKey = routeDraftThread
    ? `${routeDraftThread.environmentId}:${routeDraftThread.projectId}`
    : null;

  // ── Projects → workspaces ─────────────────────────────────────────────
  const scratchRoots = useMemo(
    () =>
      new Set(
        environments.flatMap((environment) =>
          environment.serverConfig?.scratchWorkspaceRoot
            ? [environment.serverConfig.scratchWorkspaceRoot]
            : [],
        ),
      ),
    [environments],
  );
  const projectGroups = useMemo(() => {
    const labels = new Map(environments.map((env) => [env.environmentId, env.label] as const));
    const groups = buildSidebarProjectSnapshots({
      projects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => labels.get(environmentId) ?? null,
    });
    return sortLogicalProjectsForSidebar(groups, threads, sidebarProjectSortOrder);
  }, [
    environments,
    primaryEnvironmentId,
    projectGroupingSettings,
    projects,
    sidebarProjectSortOrder,
    threads,
  ]);

  const model = useMemo(() => {
    const nowIso = new Date(now).toISOString();
    const groupByPhysical = new Map<string, SidebarProjectSnapshot>();
    for (const group of projectGroups) {
      for (const ref of group.memberProjectRefs) {
        groupByPhysical.set(`${ref.environmentId}:${ref.projectId}`, group);
      }
    }
    const threadsByGroup = new Map<string, SidebarThreadSummary[]>();
    for (const thread of threads) {
      if (thread.archivedAt !== null) continue;
      const group = groupByPhysical.get(`${thread.environmentId}:${thread.projectId}`);
      if (!group) continue;
      const list = threadsByGroup.get(group.projectKey);
      if (list) list.push(thread);
      else threadsByGroup.set(group.projectKey, [thread]);
    }
    const alwaysShow = new Set(config.alwaysShow);
    const workspaceIdByProjectKey = new Map<string, string>();
    const byWorkspace = new Map<string, WorkspaceModel>(
      config.workspaces.map((workspace) => [
        workspace.id,
        { workspace, folders: [], pinned: [], snoozed: [], threads: [] },
      ]),
    );
    for (const group of projectGroups) {
      const workspaceId =
        resolveProjectWorkspaceId(
          {
            projectKey: group.projectKey,
            workspaceRoots: group.memberProjects.map((member) => member.workspaceRoot),
          },
          config,
        ) ?? IMPLICIT_WORKSPACE.id;
      workspaceIdByProjectKey.set(group.projectKey, workspaceId);
      const bucket = byWorkspace.get(workspaceId);
      if (!bucket) continue;
      const all = threadsByGroup.get(group.projectKey) ?? [];
      const active: SidebarThreadSummary[] = [];
      const settled: SidebarThreadSummary[] = [];
      for (const thread of all) {
        const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
        bucket.threads.push(thread);
        if (capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now: nowIso })) {
          bucket.snoozed.push(thread);
        } else if (
          capabilities?.threadSettlement === true &&
          thread.settledOverride === "settled"
        ) {
          settled.push(thread);
        } else if (thread.pinnedAt != null) {
          bucket.pinned.push(thread);
        } else {
          active.push(thread);
        }
      }
      const isScratch = group.memberProjects.some((member) =>
        scratchRoots.has(member.workspaceRoot),
      );
      bucket.folders.push({
        group,
        workspaceId,
        label: isScratch ? "Chats" : group.displayName,
        isScratch,
        quiet: isProjectQuiet({
          threads: all,
          projectCreatedAt: group.createdAt ?? null,
          quietAfterDays: config.quietAfterDays,
          alwaysShow: alwaysShow.has(group.projectKey),
          now,
        }),
        active: sortThreadsForSidebar(active),
        settled: settled.toSorted(
          (left, right) =>
            (Date.parse(right.settledAt ?? "") || 0) - (Date.parse(left.settledAt ?? "") || 0),
        ),
        all,
      });
    }
    for (const bucket of byWorkspace.values()) {
      bucket.pinned = sortPinnedThreadsForSidebar(bucket.pinned);
      bucket.snoozed.sort(
        (left, right) =>
          (Date.parse(left.snoozedUntil ?? "") || 0) - (Date.parse(right.snoozedUntil ?? "") || 0),
      );
    }
    return { byWorkspace, workspaceIdByProjectKey, groupByPhysical };
  }, [config, now, projectGroups, scratchRoots, serverConfigs, threads]);

  const workspaceOfThread = useCallback(
    (thread: Pick<SidebarThreadSummary, "environmentId" | "projectId">) => {
      const group = model.groupByPhysical.get(`${thread.environmentId}:${thread.projectId}`);
      return group ? (model.workspaceIdByProjectKey.get(group.projectKey) ?? null) : null;
    },
    [model],
  );

  const threadByKey = useMemo(
    () => new Map(threads.map((thread) => [threadKeyOf(thread), thread] as const)),
    [threads],
  );
  const routeThread = routeThreadKey ? (threadByKey.get(routeThreadKey) ?? null) : null;
  const routeWorkspaceId = routeThread
    ? workspaceOfThread(routeThread)
    : routeDraftThread
      ? workspaceOfThread(routeDraftThread)
      : null;

  // ── Active workspace ──────────────────────────────────────────────────
  const workspaceIds = config.workspaces.map((workspace) => workspace.id);
  const activeWorkspaceId =
    view.activeWorkspaceId !== null && workspaceIds.includes(view.activeWorkspaceId)
      ? view.activeWorkspaceId
      : (config.defaultWorkspace ?? workspaceIds[0] ?? IMPLICIT_WORKSPACE.id);
  const activeWorkspace =
    config.workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;

  // Opening a thread from elsewhere (notification, palette, phone) follows it
  // into its workspace, and the workspace remembers it for the next switch.
  const lastFollowedRouteRef = useRef<string | null>(null);
  useEffect(() => {
    if (!routeWorkspaceId) return;
    const followKey = routeThreadKey ?? routeProjectKey;
    if (routeThreadKey) view.rememberThread(routeWorkspaceId, routeThreadKey);
    if (followKey === lastFollowedRouteRef.current) return;
    lastFollowedRouteRef.current = followKey;
    if (routeWorkspaceId !== activeWorkspaceId) view.setActiveWorkspace(routeWorkspaceId);
    // Only route changes drive this; switching tiles must not bounce back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeThreadKey, routeProjectKey, routeWorkspaceId]);

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (isMobile) setOpenMobile(false);
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [isMobile, router, setOpenMobile],
  );

  const switchWorkspace = useCallback(
    (workspaceId: string) => {
      if (workspaceId === activeWorkspaceId) return;
      view.setActiveWorkspace(workspaceId);
      lastFollowedRouteRef.current = routeThreadKey ?? routeProjectKey;
      const remembered = view.lastThreadByWorkspace[workspaceId];
      const thread = remembered ? threadByKey.get(remembered) : undefined;
      if (thread && thread.archivedAt === null && workspaceOfThread(thread) === workspaceId) {
        lastFollowedRouteRef.current = remembered ?? null;
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
        });
      }
    },
    [
      activeWorkspaceId,
      routeProjectKey,
      routeThreadKey,
      router,
      threadByKey,
      view,
      workspaceOfThread,
    ],
  );

  // ── Search ────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isSearching = searchQuery.trim().length > 0;
  const searchScopeAll = !view.tilesVisible;
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    const results: { thread: SidebarThreadSummary; folder: FolderModel }[] = [];
    for (const bucket of model.byWorkspace.values()) {
      if (!searchScopeAll && bucket.workspace.id !== activeWorkspaceId) continue;
      for (const folder of bucket.folders) {
        const folderMatches = folder.label.toLowerCase().includes(query);
        for (const thread of folder.all) {
          if (
            folderMatches ||
            thread.title.toLowerCase().includes(query) ||
            (thread.branch ?? "").toLowerCase().includes(query)
          ) {
            results.push({ thread, folder });
          }
        }
      }
    }
    return results.toSorted(
      (left, right) => threadActivityMs(right.thread) - threadActivityMs(left.thread),
    );
  }, [activeWorkspaceId, model, searchQuery, searchScopeAll]);

  // ── Thread actions ────────────────────────────────────────────────────
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [menuRequest, setMenuRequest] = useState<{
    ref: ScopedThreadRef;
    position: { x: number; y: number };
    nonce: number;
  } | null>(null);
  const menuThread = menuRequest ? readProjectCwd(menuRequest.ref) : null;
  function readProjectCwd(ref: ScopedThreadRef): string | null {
    const thread = threadByKey.get(scopedThreadKey(ref));
    if (!thread) return null;
    return (
      projects.find(
        (project) =>
          project.environmentId === thread.environmentId && project.id === thread.projectId,
      )?.workspaceRoot ?? null
    );
  }
  const { openMenu } = useThreadActionMenu({
    threadRef: menuRequest?.ref ?? null,
    projectCwd: menuThread,
    onStartRename: () => {
      if (menuRequest) setRenamingKey(scopedThreadKey(menuRequest.ref));
    },
  });
  useEffect(() => {
    if (menuRequest) openMenu(menuRequest.position);
    // A new request (nonce) opens the menu once; openMenu identity churns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuRequest?.nonce]);
  const handleThreadContextMenu = useCallback(
    (ref: ScopedThreadRef, position: { x: number; y: number }) => {
      setMenuRequest((previous) => ({ ref, position, nonce: (previous?.nonce ?? 0) + 1 }));
    },
    [],
  );
  const handleTogglePin = useCallback(
    (thread: SidebarThreadSummary) => {
      const ref = scopeThreadRef(thread.environmentId, thread.id);
      void (thread.pinnedAt != null
        ? reportFailure("Failed to unpin thread", () => confirmAndUnpinThread(ref))
        : reportFailure("Failed to pin thread", () => pinThread(ref)));
    },
    [confirmAndUnpinThread, pinThread],
  );
  const handleSettle = useCallback(
    (ref: ScopedThreadRef) =>
      void reportFailure("Failed to settle thread", () => settleThread(ref)),
    [settleThread],
  );
  const handleUnsettle = useCallback(
    (ref: ScopedThreadRef) =>
      void reportFailure("Failed to un-settle thread", () => unsettleThread(ref)),
    [unsettleThread],
  );
  const handleWake = useCallback(
    (ref: ScopedThreadRef) =>
      void reportFailure("Failed to wake thread", () => unsnoozeThread(ref)),
    [unsnoozeThread],
  );
  const handleCommitRename = useCallback(
    (ref: ScopedThreadRef, title: string | null) => {
      setRenamingKey(null);
      const thread = threadByKey.get(scopedThreadKey(ref));
      const trimmed = title?.trim();
      if (!thread || !trimmed || trimmed === thread.title) return;
      void reportFailure("Failed to rename thread", () =>
        updateThreadMetadata({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId, title: trimmed },
        }),
      );
    },
    [threadByKey, updateThreadMetadata],
  );
  const startThreadInFolder = useCallback(
    (folder: FolderModel) => {
      const member =
        folder.group.memberProjects.find(
          (project) => project.environmentId === primaryEnvironmentId,
        ) ?? folder.group.memberProjects[0];
      if (!member) return;
      if (isMobile) setOpenMobile(false);
      void handleNewThread(scopeProjectRef(member.environmentId, member.id)).catch((error) =>
        failureToast("Could not create thread", error),
      );
    },
    [handleNewThread, isMobile, primaryEnvironmentId, setOpenMobile],
  );

  // ── Workspace edits ───────────────────────────────────────────────────
  const [renamingWorkspace, setRenamingWorkspace] = useState(false);
  const createWorkspace = useCallback(() => {
    const current = configRef.current;
    const taken = new Set(current.workspaces.map((workspace) => workspace.id));
    const name = `Workspace ${current.workspaces.length + 1}`;
    const id = makeWorkspaceId(name, taken);
    const usedColors = new Set(current.workspaces.map((workspace) => workspaceColor(workspace)));
    const color =
      WORKSPACE_COLORS.find((candidate) => !usedColors.has(candidate)) ?? WORKSPACE_COLORS[0];
    writeConfig((config) => ({
      ...config,
      workspaces: [...config.workspaces, { id, name, color }],
    }));
    view.setActiveWorkspace(id);
    setRenamingWorkspace(true);
  }, [view, writeConfig]);
  const renameWorkspace = useCallback(
    (workspaceId: string, name: string | null) => {
      setRenamingWorkspace(false);
      const trimmed = name?.trim();
      if (!trimmed) return;
      writeConfig((config) => ({
        ...config,
        workspaces: config.workspaces.map((workspace) =>
          workspace.id === workspaceId ? { ...workspace, name: trimmed } : workspace,
        ),
      }));
    },
    [writeConfig],
  );
  const moveProject = useCallback(
    (projectKey: string, workspaceId: string) => {
      writeConfig((config) => ({
        ...config,
        assignments: { ...config.assignments, [projectKey]: workspaceId },
      }));
    },
    [writeConfig],
  );
  const openWorkspaceMenu = useCallback(
    async (workspaceId: string, position: { x: number; y: number }) => {
      const api = readLocalApi();
      const workspace = configRef.current.workspaces.find((entry) => entry.id === workspaceId);
      if (!api || !workspace) return;
      const items: ContextMenuItem[] = [
        { id: "rename", label: "Rename", icon: "pencil" },
        {
          id: "color",
          label: "Color",
          children: WORKSPACE_COLORS.map((color, index) => ({
            id: `color:${color}`,
            label:
              ["Blue", "Coral", "Green", "Violet", "Amber", "Teal", "Rose", "Olive"][index] ??
              color,
            checked: workspaceColor(workspace) === color,
          })),
        },
        {
          id: "default",
          label: "Default for new projects",
          checked: configRef.current.defaultWorkspace === workspaceId,
          separatorBefore: true,
        },
        ...(configRef.current.workspaces.length > 1
          ? [
              {
                id: "delete",
                label: "Delete workspace",
                icon: "trash",
                destructive: true,
                separatorBefore: true,
              },
            ]
          : []),
      ];
      const clicked = await api.contextMenu.show(items, position);
      if (!clicked) return;
      if (clicked === "rename") {
        view.setActiveWorkspace(workspaceId);
        setRenamingWorkspace(true);
      } else if (clicked.startsWith("color:")) {
        const color = clicked.slice("color:".length);
        writeConfig((config) => ({
          ...config,
          workspaces: config.workspaces.map((entry) =>
            entry.id === workspaceId ? { ...entry, color } : entry,
          ),
        }));
      } else if (clicked === "default") {
        writeConfig((config) => ({ ...config, defaultWorkspace: workspaceId }));
      } else if (clicked === "delete") {
        const confirmed = await api.dialogs.confirm(
          `Delete workspace "${workspace.name}"? Its projects move to the default workspace; no threads are deleted.`,
        );
        if (!confirmed) return;
        writeConfig((config) => {
          const remaining = config.workspaces.filter((entry) => entry.id !== workspaceId);
          return {
            ...config,
            workspaces: remaining,
            assignments: Object.fromEntries(
              Object.entries(config.assignments).filter(([, target]) => target !== workspaceId),
            ),
            rules: config.rules.filter((rule) => rule.workspace !== workspaceId),
            defaultWorkspace:
              config.defaultWorkspace === workspaceId
                ? (remaining[0]?.id ?? null)
                : config.defaultWorkspace,
          };
        });
        if (activeWorkspaceId === workspaceId) view.setActiveWorkspace(null);
      }
    },
    [activeWorkspaceId, view, writeConfig],
  );
  const openFolderMenu = useCallback(
    async (folder: FolderModel, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const projectKey = folder.group.projectKey;
      const isAlwaysShown = configRef.current.alwaysShow.includes(projectKey);
      const items: ContextMenuItem[] = [
        { id: "new-thread", label: "New thread", icon: "message-square-plus" },
        {
          id: "move",
          label: "Move to workspace",
          icon: "folder",
          children: configRef.current.workspaces.map((workspace) => ({
            id: `move:${workspace.id}`,
            label: workspace.name,
            checked: workspace.id === folder.workspaceId,
          })),
        },
        {
          id: "always-show",
          label: "Never fold into quiet projects",
          checked: isAlwaysShown,
        },
        { id: "settings", label: "Project settings", icon: "settings", separatorBefore: true },
      ];
      const clicked = await api.contextMenu.show(items, position);
      if (!clicked) return;
      if (clicked === "new-thread") startThreadInFolder(folder);
      else if (clicked.startsWith("move:")) moveProject(projectKey, clicked.slice("move:".length));
      else if (clicked === "always-show") {
        writeConfig((config) => ({
          ...config,
          alwaysShow: isAlwaysShown
            ? config.alwaysShow.filter((key) => key !== projectKey)
            : [...config.alwaysShow, projectKey],
        }));
      } else if (clicked === "settings") {
        if (isMobile) setOpenMobile(false);
        void router.navigate({ to: "/projects/$projectKey", params: { projectKey } });
      }
    },
    [isMobile, moveProject, router, setOpenMobile, startThreadInFolder, writeConfig],
  );

  // ── Ordered rows for jump / traversal shortcuts ───────────────────────
  const visibleWorkspaces = view.tilesVisible
    ? [model.byWorkspace.get(activeWorkspaceId)].filter((entry): entry is WorkspaceModel => !!entry)
    : [...model.byWorkspace.values()];
  const orderedThreadKeys = useMemo(() => {
    if (isSearching) return searchResults.map(({ thread }) => threadKeyOf(thread));
    const keys: string[] = [];
    for (const bucket of visibleWorkspaces) {
      for (const thread of bucket.pinned) keys.push(threadKeyOf(thread));
      for (const folder of bucket.folders) {
        if (folder.quiet) continue;
        const open = view.folderOpen[`${bucket.workspace.id}:${folder.group.projectKey}`] ?? true;
        if (!open) continue;
        for (const thread of folder.active.slice(0, FOLDER_PREVIEW_COUNT))
          keys.push(threadKeyOf(thread));
      }
    }
    return keys;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSearching, searchResults, model, activeWorkspaceId, view.tilesVisible, view.folderOpen]);
  const jumpLabelByKey = useMemo(
    () => new Map(orderedThreadKeys.slice(0, 9).map((key, index) => [key, String(index + 1)])),
    [orderedThreadKeys],
  );
  const [showJumpHints, setShowJumpHints] = useState(false);

  // ── Keyboard ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen() || isModelPickerOpen()) return;
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^Digit[0-9]$/.test(event.code)) {
        const digit = Number(event.code.slice(5));
        event.preventDefault();
        if (digit === 0) {
          view.toggleTiles();
          return;
        }
        const target = configRef.current.workspaces[digit - 1];
        if (target) {
          if (!view.tilesVisible) view.toggleTiles();
          switchWorkspace(target.id);
        }
        return;
      }
      if (event.repeat) return;
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: { terminalFocus: isTerminalFocused(), modelPickerOpen: isModelPickerOpen() },
      });
      const go = (key: string | null | undefined) => {
        const thread = key ? threadByKey.get(key) : undefined;
        if (!thread) return;
        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(thread.environmentId, thread.id));
      };
      const direction = threadTraversalDirectionFromCommand(command);
      if (direction !== null) {
        go(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeThreadKey,
            direction,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex !== null) go(orderedThreadKeys[jumpIndex]);
    };
    const onModifier = (event: KeyboardEvent) => {
      setShowJumpHints((event.ctrlKey || event.metaKey) && event.type === "keydown");
    };
    const onBlur = () => setShowJumpHints(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keydown", onModifier);
    window.addEventListener("keyup", onModifier);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keydown", onModifier);
      window.removeEventListener("keyup", onModifier);
      window.removeEventListener("blur", onBlur);
    };
  }, [
    keybindings,
    navigateToThread,
    orderedThreadKeys,
    routeThreadKey,
    switchWorkspace,
    threadByKey,
    view,
  ]);

  // ── Activity per workspace (tiles) ────────────────────────────────────
  const lastVisitedOf = useCallback(
    (thread: SidebarThreadSummary) => lastVisitedById[threadKeyOf(thread)],
    [lastVisitedById],
  );
  const tileEntries: WorkspaceTileEntry[] = useMemo(
    () =>
      config.workspaces.map((workspace) => {
        const bucket = model.byWorkspace.get(workspace.id);
        return {
          workspace,
          activity: bucket
            ? summarizeWorkspaceActivity(bucket.threads, lastVisitedOf)
            : EMPTY_WORKSPACE_ACTIVITY,
        };
      }),
    [config.workspaces, lastVisitedOf, model],
  );

  // ── Render ────────────────────────────────────────────────────────────
  const capabilitiesOf = (thread: SidebarThreadSummary) =>
    serverConfigs.get(thread.environmentId)?.environment.capabilities;
  const renderRow = (
    thread: SidebarThreadSummary,
    variant: WorkspaceRowVariant,
    projectLabel?: string | null,
  ) => {
    const key = threadKeyOf(thread);
    const capabilities = capabilitiesOf(thread);
    return (
      <WorkspaceThreadRow
        key={key}
        thread={thread}
        variant={variant}
        isActive={key === routeThreadKey}
        now={now}
        projectLabel={projectLabel ?? null}
        jumpLabel={showJumpHints ? (jumpLabelByKey.get(key) ?? null) : null}
        isRenaming={renamingKey === key}
        canSettle={capabilities?.threadSettlement === true}
        canPin={capabilities?.threadPinning === true}
        onOpen={navigateToThread}
        onContextMenu={handleThreadContextMenu}
        onTogglePin={handleTogglePin}
        onSettle={handleSettle}
        onUnsettle={handleUnsettle}
        onWake={handleWake}
        onCommitRename={handleCommitRename}
      />
    );
  };
  const labelOfThread = (thread: SidebarThreadSummary) => {
    const group = model.groupByPhysical.get(`${thread.environmentId}:${thread.projectId}`);
    if (!group) return null;
    return group.memberProjects.some((member) => scratchRoots.has(member.workspaceRoot))
      ? "Chats"
      : group.displayName;
  };

  const renderFolder = (folder: FolderModel) => {
    const folderKey = `${folder.workspaceId}:${folder.group.projectKey}`;
    const open = view.folderOpen[folderKey] ?? !folder.quiet;
    const expanded = view.folderExpanded[folderKey] ?? false;
    const settledOpen = view.settledOpen[folderKey] ?? false;
    let visible = folder.active;
    if (!expanded && visible.length > FOLDER_PREVIEW_COUNT) {
      visible = visible.slice(0, FOLDER_PREVIEW_COUNT);
      const activeRow = folder.active.find((thread) => threadKeyOf(thread) === routeThreadKey);
      if (activeRow && !visible.includes(activeRow)) visible = [...visible, activeRow];
    }
    const collapsedActive = !open
      ? folder.active.find((thread) => threadKeyOf(thread) === routeThreadKey)
      : undefined;
    const attention = folder.all.filter(needsAttention).length;
    const working = folder.all.filter(
      (thread) => thread.session?.status === "running" && thread.session.activeTurnId != null,
    ).length;
    return (
      <div key={folderKey} className="flex flex-col">
        <div
          role="button"
          tabIndex={0}
          draggable
          aria-expanded={open}
          title={folder.group.memberProjects.map((member) => member.workspaceRoot).join("\n")}
          className="group/ws-folder flex h-7 cursor-pointer select-none items-center gap-1.5 rounded-md pr-1 pl-1 text-[13px] font-medium text-sidebar-foreground outline-hidden transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => view.setFolderOpen(folderKey, !open)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              view.setFolderOpen(folderKey, !open);
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            void openFolderMenu(folder, { x: event.clientX, y: event.clientY });
          }}
          onDragStart={(event) => {
            event.dataTransfer.setData(WORKSPACE_PROJECT_DRAG_TYPE, folder.group.projectKey);
            event.dataTransfer.effectAllowed = "move";
          }}
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-sidebar-muted-foreground transition-transform duration-150",
              open && "rotate-90",
            )}
          />
          {folder.isScratch ? (
            <MessagesSquareIcon className="size-4 shrink-0 text-sidebar-muted-foreground" />
          ) : (
            <ProjectFavicon project={folder.group} className="size-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{folder.label}</span>
          {!open && (attention > 0 || working > 0) ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold tabular-nums group-hover/ws-folder:hidden">
              {attention > 0 ? <span className="text-warning-foreground">◆{attention}</span> : null}
              {working > 0 ? (
                <span className="text-sky-600 dark:text-sky-400">●{working}</span>
              ) : null}
            </span>
          ) : null}
          <span className="hidden shrink-0 items-center gap-0.5 group-hover/ws-folder:flex group-focus-within/ws-folder:flex">
            <FolderAction
              label={`New thread in ${folder.label}`}
              onClick={() => startThreadInFolder(folder)}
            >
              <SquarePenIcon />
            </FolderAction>
            <FolderAction
              label="Project actions"
              onClick={(position) => void openFolderMenu(folder, position)}
            >
              <EllipsisIcon />
            </FolderAction>
          </span>
        </div>
        {open ? (
          <div className="flex flex-col pl-3">
            {visible.map((thread) => renderRow(thread, "active"))}
            {folder.active.length > FOLDER_PREVIEW_COUNT ? (
              <MoreButton onClick={() => view.toggleFolderExpanded(folderKey)}>
                {expanded ? "Show less" : `Show ${folder.active.length - visible.length} more`}
              </MoreButton>
            ) : null}
            {folder.active.length === 0 && folder.settled.length === 0 ? (
              <MoreButton onClick={() => startThreadInFolder(folder)}>
                <SquarePenIcon className="size-3" /> New thread
              </MoreButton>
            ) : null}
            {folder.settled.length > 0 ? (
              <>
                {settledOpen
                  ? folder.settled
                      .slice(0, expanded ? undefined : SETTLED_PAGE_COUNT)
                      .map((thread) => renderRow(thread, "settled"))
                  : null}
                <MoreButton onClick={() => view.toggleSettledOpen(folderKey)}>
                  {settledOpen ? "Hide settled" : `${folder.settled.length} settled`}
                </MoreButton>
              </>
            ) : null}
          </div>
        ) : collapsedActive ? (
          <div className="flex flex-col pl-3">{renderRow(collapsedActive, "active")}</div>
        ) : null}
      </div>
    );
  };

  const renderWorkspaceBody = (bucket: WorkspaceModel, nested: boolean) => {
    const loud = bucket.folders.filter((folder) => !folder.quiet);
    const quiet = bucket.folders.filter((folder) => folder.quiet);
    const quietKey = `quiet:${bucket.workspace.id}`;
    const quietHoldsActive = quiet.some((folder) =>
      folder.all.some((thread) => threadKeyOf(thread) === routeThreadKey),
    );
    const quietOpen = (view.sectionOpen[quietKey] ?? false) || quietHoldsActive;
    const snoozedKey = `snoozed:${bucket.workspace.id}`;
    const snoozedOpen = view.sectionOpen[snoozedKey] ?? false;
    return (
      <div className="flex flex-col gap-0.5">
        {!nested && bucket.pinned.length > 0 ? (
          <Section icon={<PinIcon className="size-3" />} label="Pinned">
            {bucket.pinned.map((thread) => renderRow(thread, "pinned", labelOfThread(thread)))}
          </Section>
        ) : null}
        {bucket.folders.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs leading-relaxed text-sidebar-muted-foreground">
            No projects in{" "}
            <span className="font-medium text-sidebar-foreground">{bucket.workspace.name}</span>{" "}
            yet.
            <br />
            Drag a project folder onto its tile, or use “Move to workspace” in a folder menu.
          </div>
        ) : null}
        {loud.map(renderFolder)}
        {quiet.length > 0 ? (
          <CollapsibleSection
            label="Quiet projects"
            count={quiet.length}
            open={quietOpen}
            title={`No activity for ${config.quietAfterDays}+ days`}
            onToggle={() => view.setSectionOpen(quietKey, !quietOpen)}
          >
            {quiet.map(renderFolder)}
          </CollapsibleSection>
        ) : null}
        {!nested && bucket.snoozed.length > 0 ? (
          <CollapsibleSection
            icon={<AlarmClockIcon className="size-3" />}
            label="Snoozed"
            count={bucket.snoozed.length}
            open={snoozedOpen}
            onToggle={() => view.setSectionOpen(snoozedKey, !snoozedOpen)}
          >
            {bucket.snoozed.map((thread) => renderRow(thread, "snoozed", labelOfThread(thread)))}
          </CollapsibleSection>
        ) : null}
      </div>
    );
  };

  const renderAllWorkspaces = () => {
    const allPinned = [...model.byWorkspace.values()].flatMap((bucket) => bucket.pinned);
    const allSnoozed = [...model.byWorkspace.values()].flatMap((bucket) => bucket.snoozed);
    const snoozedOpen = view.sectionOpen["snoozed:all"] ?? false;
    return (
      <div className="flex flex-col gap-1">
        {allPinned.length > 0 ? (
          <Section icon={<PinIcon className="size-3" />} label="Pinned">
            {allPinned.map((thread) => renderRow(thread, "pinned", labelOfThread(thread)))}
          </Section>
        ) : null}
        {[...model.byWorkspace.values()].map((bucket) => {
          const key = `ws:${bucket.workspace.id}`;
          const open = view.sectionOpen[key] ?? true;
          const activity =
            tileEntries.find((entry) => entry.workspace.id === bucket.workspace.id)?.activity ??
            EMPTY_WORKSPACE_ACTIVITY;
          return (
            <Fragment key={bucket.workspace.id}>
              <button
                type="button"
                className="mt-1 flex h-7 items-center gap-2 rounded-md px-1 text-left text-xs font-semibold tracking-tight text-sidebar-foreground outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={open}
                onClick={() => view.setSectionOpen(key, !open)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void openWorkspaceMenu(bucket.workspace.id, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
              >
                <ChevronRightIcon
                  className={cn(
                    "size-3.5 text-sidebar-muted-foreground transition-transform",
                    open && "rotate-90",
                  )}
                />
                <WorkspaceAvatar workspace={bucket.workspace} />
                <span className="min-w-0 flex-1 truncate">{bucket.workspace.name}</span>
                {!open && activity.attention > 0 ? (
                  <span className="text-[11px] text-warning-foreground">◆{activity.attention}</span>
                ) : null}
              </button>
              {open ? <div className="pl-1">{renderWorkspaceBody(bucket, true)}</div> : null}
            </Fragment>
          );
        })}
        {allSnoozed.length > 0 ? (
          <CollapsibleSection
            icon={<AlarmClockIcon className="size-3" />}
            label="Snoozed"
            count={allSnoozed.length}
            open={snoozedOpen}
            onToggle={() => view.setSectionOpen("snoozed:all", !snoozedOpen)}
          >
            {allSnoozed.map((thread) => renderRow(thread, "snoozed", labelOfThread(thread)))}
          </CollapsibleSection>
        ) : null}
      </div>
    );
  };

  const renderSearch = () =>
    searchResults.length === 0 ? (
      <div className="px-3 py-6 text-center text-xs text-sidebar-muted-foreground">
        No threads found.
      </div>
    ) : (
      <div className="flex flex-col">
        {searchResults.map(({ thread, folder }) =>
          renderRow(
            thread,
            thread.settledOverride === "settled" ? "settled" : "active",
            folder.label,
          ),
        )}
      </div>
    );

  const accent = activeWorkspace && view.tilesVisible ? workspaceColor(activeWorkspace) : null;
  const headerWorkspace = view.tilesVisible ? activeWorkspace : null;

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      style={accent ? ({ "--ws-accent": accent } as CSSProperties) : undefined}
    >
      {accent ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-linear-to-b from-[color-mix(in_oklab,var(--ws-accent)_13%,transparent)] to-transparent"
        />
      ) : null}
      <WorkspaceTitlebar
        workspace={headerWorkspace}
        isElectron={isElectron}
        isRenaming={renamingWorkspace && headerWorkspace !== null}
        onStartRename={() => setRenamingWorkspace(true)}
        onCommitRename={(name) => headerWorkspace && renameWorkspace(headerWorkspace.id, name)}
        onContextMenu={(event) => {
          event.preventDefault();
          if (headerWorkspace) {
            void openWorkspaceMenu(headerWorkspace.id, { x: event.clientX, y: event.clientY });
          }
        }}
        actions={
          <>
            <SidebarHeaderIconButton
              label="Add project"
              onClick={() => openCommandPalette({ open: "add-project" })}
            >
              <FolderPlusIcon />
            </SidebarHeaderIconButton>
            <SidebarHeaderIconButton
              label="New thread"
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                openCommandPalette({ open: "new-thread-in" });
              }}
            >
              <SquarePenIcon />
            </SidebarHeaderIconButton>
          </>
        }
      />
      <div className="relative px-2 pb-1">
        <div className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-sidebar-muted-foreground transition-colors focus-within:bg-sidebar-row-hover hover:bg-sidebar-row-hover">
          <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
          <SidebarInput
            ref={searchInputRef}
            nativeInput
            type="search"
            value={searchQuery}
            placeholder={
              searchScopeAll || !activeWorkspace ? "Search" : `Search ${activeWorkspace.name}`
            }
            aria-label="Search threads"
            className="min-w-0 flex-1"
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearchQuery("");
                searchInputRef.current?.blur();
              } else if (event.key === "Enter") {
                const first = searchResults[0];
                if (first)
                  navigateToThread(scopeThreadRef(first.thread.environmentId, first.thread.id));
              }
            }}
          />
          {isSearching ? (
            <button
              type="button"
              aria-label="Clear search"
              className="flex size-5 items-center justify-center rounded hover:bg-foreground/8"
              onClick={() => setSearchQuery("")}
            >
              <XIcon className="size-3" />
            </button>
          ) : null}
        </div>
      </div>
      <SidebarContent className="relative px-2 pb-2">
        {isSearching
          ? renderSearch()
          : view.tilesVisible
            ? (() => {
                const bucket = model.byWorkspace.get(activeWorkspaceId);
                return bucket ? renderWorkspaceBody(bucket, false) : null;
              })()
            : renderAllWorkspaces()}
      </SidebarContent>
      <WorkspaceDock
        entries={tileEntries}
        activeWorkspaceId={activeWorkspaceId}
        tilesVisible={view.tilesVisible}
        onSelect={switchWorkspace}
        onTileContextMenu={(workspaceId, position) => void openWorkspaceMenu(workspaceId, position)}
        onCreate={createWorkspace}
        onToggleTiles={view.toggleTiles}
        onDropProject={moveProject}
      />
      <SidebarChromeFooter />
    </div>
  );
}

function FolderAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: (position: { x: number; y: number }) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="flex size-5 items-center justify-center rounded text-sidebar-muted-foreground transition-colors hover:bg-foreground/8 hover:text-sidebar-foreground [&_svg]:size-3.5"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick({ x: event.clientX, y: event.clientY });
      }}
    >
      {children}
    </button>
  );
}

function MoreButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="flex h-6 items-center gap-1.5 rounded-md pl-[1.875rem] text-left text-xs text-sidebar-muted-foreground outline-hidden transition-colors hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Section({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-1 flex flex-col">
      <div className="flex h-6 items-center gap-1.5 px-2 text-[11px] font-medium tracking-wide text-sidebar-muted-foreground uppercase">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}

function CollapsibleSection({
  icon,
  label,
  count,
  open,
  title,
  onToggle,
  children,
}: {
  icon?: ReactNode;
  label: string;
  count: number;
  open: boolean;
  title?: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mt-1 flex flex-col">
      <button
        type="button"
        title={title}
        aria-expanded={open}
        className="flex h-6 items-center gap-1.5 rounded-md px-1 text-left text-[11px] font-medium tracking-wide text-sidebar-muted-foreground uppercase outline-hidden transition-colors hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onToggle}
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        {icon}
        <span>{label}</span>
        <span className="ml-auto pr-1 tabular-nums">{count}</span>
      </button>
      {open ? <div className="flex flex-col">{children}</div> : null}
    </div>
  );
}
