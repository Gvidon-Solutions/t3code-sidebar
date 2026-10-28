/**
 * Workspace sidebar (fork feature): workspace tiles at the bottom and the open workspace's projects
 * as folders of one-line threads. It reuses the default sidebar's data and mutations and owns only
 * layout and workspace bookkeeping. The workspace config is a shared server setting.
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
import {
  groupThreadAgents,
  summarizeThreadAgents,
  threadAgentsChoiceKey,
  threadAgentsDisplay,
  threadAgentsLive,
} from "@t3tools/client-runtime/state/thread-agents";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type ContextMenuItem,
  type EnvironmentId,
  type ProjectIconOverride,
  type ScopedThreadRef,
  type SidebarWorkspace,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import {
  AudioLinesIcon,
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
  lazy,
  Suspense,
  useEffect,
  useEffectEvent,
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
import { projectEnvironment } from "../../state/projects";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { useTalk } from "../../voice/useTalk";
import { useVoiceThreadRef } from "../../voice/voiceMode";
import { ProjectFavicon } from "../ProjectFavicon";
import { canShareWithGuestAtom } from "../chat/guestShareAvailability";
import {
  resolveAdjacentThreadId,
  resolveSidebarThreadStatus,
  sortLogicalProjectsForSidebar,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
} from "../Sidebar.logic";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SidebarContent, SidebarInput, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WORKSPACE_PROJECT_DRAG_TYPE,
  WorkspaceAvatar,
  WorkspaceDock,
  WorkspaceTitlebar,
  type WorkspaceTileEntry,
  type WorkspaceTitleEditing,
  WORKSPACE_GLYPHS,
} from "./WorkspaceChrome";
import { WorkspaceAgentGroup } from "./WorkspaceAgentGroup";
import { WorkspaceUpdateStrip } from "./WorkspaceUpdateStrip";
import { WorkspaceThreadRow, type WorkspaceRowVariant } from "./WorkspaceThreadRow";
import { useWorkspaceViewStore } from "./workspaceViewStore";
import {
  effectiveDefaultWorkspaceId,
  EMPTY_WORKSPACE_ACTIVITY,
  addWorkspace,
  deleteWorkspace,
  dropProjectOnWorkspace,
  isProjectQuiet,
  isThreadUnread,
  moveProjectInWorkspace,
  needsAttention,
  normalizeWorkspaceLabel,
  projectFoldModeOf,
  projectOrderOf,
  type ProjectFoldMode,
  reorderWorkspaces,
  resolveProjectWorkspaceIds,
  setProjectFoldMode,
  sortWorkspaceProjects,
  toggleProjectWorkspace,
  summarizeWorkspaceActivity,
  threadActivityMs,
  WORKSPACE_COLORS,
  workspaceColor,
  WORKSPACE_GLYPH_PREFIX,
  updateWorkspace,
} from "./workspaces.logic";

const FOLDER_PREVIEW_COUNT = 8;
const SETTLED_PAGE_COUNT = 10;
/** Stand-in until the user creates a workspace: everything lives here. */
const IMPLICIT_WORKSPACE: SidebarWorkspace = { id: "personal", name: "Personal" };
const SCRATCH_LABEL = "No project";

interface FolderModel {
  group: SidebarProjectSnapshot;
  /** The workspace this copy of the folder shows in; a project can show in several. */
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

/** What the shortcuts walk: pinned threads, then folders. */
type ThreadListModel = Pick<WorkspaceModel, "pinned" | "folders">;

/** Snoozed threads, the soonest to wake first. */
function sortSnoozedThreads(threads: readonly SidebarThreadSummary[]): SidebarThreadSummary[] {
  return threads.toSorted(
    (left, right) =>
      (Date.parse(left.snoozedUntil ?? "") || 0) - (Date.parse(right.snoozedUntil ?? "") || 0),
  );
}

function projectIdentity(group: SidebarProjectSnapshot, isScratch: boolean) {
  return {
    projectKey: group.projectKey,
    workspaceRoots: group.memberProjects.map((member) => member.workspaceRoot),
    isScratch,
  };
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

const ProjectIconPickerDialog = lazy(() =>
  import("../settings/ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

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
  const primaryConfig = usePrimarySettings((s) => s.sidebarWorkspaces);
  const updatePrimarySettings = useUpdatePrimarySettings();
  const lastVisitedById = useUiStateStore((s) => s.threadLastVisitedAtById);
  const nowMinute = useNowMinute();
  const now = Date.parse(nowMinute);

  const view = useWorkspaceViewStore();
  const { settleThread, unsettleThread, unsnoozeThread, pinThread, confirmAndUnpinThread } =
    useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  const talk = useTalk();
  const voiceThreadRef = useVoiceThreadRef();

  // Config: edits go to every server that syncs shared settings. Reads prefer a connected remote
  // with workspaces (first by id, as the phone picks), so the desktop shows what the phone shows.
  const remoteConfig = [...serverConfigs]
    .filter(
      ([environmentId, serverConfig]) =>
        environmentId !== primaryEnvironmentId &&
        serverConfig.settings.sidebarWorkspaces.workspaces.length > 0,
    )
    .sort(([left], [right]) => left.localeCompare(right))[0];
  const storedConfig = remoteConfig?.[1].settings.sidebarWorkspaces ?? primaryConfig;
  const baseConfig = storedConfig ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG;
  const config: SidebarWorkspacesConfig =
    baseConfig.workspaces.length > 0
      ? baseConfig
      : {
          ...baseConfig,
          workspaces: [IMPLICIT_WORKSPACE],
          defaultWorkspace: IMPLICIT_WORKSPACE.id,
        };
  const writeConfig = (update: (current: SidebarWorkspacesConfig) => SidebarWorkspacesConfig) => {
    updatePrimarySettings({ sidebarWorkspaces: update(config) });
  };

  const routeTarget = useParams({ strict: false, select: resolveThreadRouteTarget });
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = resolveActiveThreadRouteRef(routeTarget, routeDraftThread);
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeProjectKey = routeDraftThread
    ? `${routeDraftThread.environmentId}:${routeDraftThread.projectId}`
    : null;

  // ── Projects → workspaces ─────────────────────────────────────────────
  const scratchRoots = new Set(
    environments.flatMap((environment) =>
      environment.serverConfig?.scratchWorkspaceRoot
        ? [environment.serverConfig.scratchWorkspaceRoot]
        : [],
    ),
  );
  const environmentLabels = new Map(
    environments.map((env) => [env.environmentId, env.label] as const),
  );
  const projectGroups = sortLogicalProjectsForSidebar(
    buildSidebarProjectSnapshots({
      projects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => environmentLabels.get(environmentId) ?? null,
    }),
    threads,
    sidebarProjectSortOrder,
  );

  const model = (() => {
    const nowIso = new Date(now).toISOString();
    const groupByPhysical = new Map<string, SidebarProjectSnapshot>();
    for (const group of projectGroups) {
      for (const ref of group.memberProjectRefs) {
        groupByPhysical.set(`${ref.environmentId}:${ref.projectId}`, group);
      }
    }
    const agents = groupThreadAgents(threads);
    const threadsByGroup = new Map<string, SidebarThreadSummary[]>();
    for (const thread of threads) {
      if (thread.archivedAt !== null) continue;
      const group = groupByPhysical.get(`${thread.environmentId}:${thread.projectId}`);
      if (!group) continue;
      const list = threadsByGroup.get(group.projectKey);
      if (list) list.push(thread);
      else threadsByGroup.set(group.projectKey, [thread]);
    }
    const workspaceIdsByProjectKey = new Map<string, string[]>();
    const scratchProjectKeys = new Set<string>();
    // Pinned threads show in every workspace; tiles still count them where their project shows.
    const pinned: SidebarThreadSummary[] = [];
    const byWorkspace = new Map<string, WorkspaceModel>(
      config.workspaces.map((workspace) => [
        workspace.id,
        { workspace, folders: [], pinned: [], snoozed: [], threads: [] },
      ]),
    );
    for (const group of projectGroups) {
      const isScratch = group.memberProjects.some((member) =>
        scratchRoots.has(member.workspaceRoot),
      );
      if (isScratch) scratchProjectKeys.add(group.projectKey);
      const workspaceIds = resolveProjectWorkspaceIds(projectIdentity(group, isScratch), config);
      workspaceIdsByProjectKey.set(group.projectKey, workspaceIds);
      const all = threadsByGroup.get(group.projectKey) ?? [];
      const active: SidebarThreadSummary[] = [];
      const settled: SidebarThreadSummary[] = [];
      const snoozed: SidebarThreadSummary[] = [];
      for (const thread of all) {
        const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
        // Subagents hang under the thread that started them (renderThread).
        if (agents.nested.has(threadKeyOf(thread))) continue;
        if (capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now: nowIso })) {
          snoozed.push(thread);
        } else if (
          capabilities?.threadSettlement === true &&
          thread.settledOverride === "settled"
        ) {
          settled.push(thread);
        } else if (thread.pinnedAt != null) {
          pinned.push(thread);
        } else {
          active.push(thread);
        }
      }
      const folder: Omit<FolderModel, "workspaceId"> = {
        group,
        label: isScratch ? SCRATCH_LABEL : group.displayName,
        isScratch,
        quiet: false,
        active: sortThreadsForSidebar(active),
        settled: settled.toSorted(
          (left, right) =>
            (Date.parse(right.settledAt ?? "") || 0) - (Date.parse(left.settledAt ?? "") || 0),
        ),
        all,
      };
      // Each workspace keeps its own hand-made choice; the rule itself is shared.
      const quietOf = (foldMode: ProjectFoldMode) =>
        !isScratch &&
        isProjectQuiet({
          threads: all,
          projectCreatedAt: group.createdAt ?? null,
          quietAfterDays: config.quietAfterDays,
          foldMode,
          now,
        });
      const quietByItself = quietOf("auto");
      for (const workspaceId of workspaceIds) {
        const bucket = byWorkspace.get(workspaceId);
        if (!bucket) continue;
        const foldMode = projectFoldModeOf(config, workspaceId, group.projectKey);
        // "No project" never folds away: it sits last, below Quiet projects.
        const quiet = foldMode === "auto" ? quietByItself : quietOf(foldMode);
        bucket.folders.push({ ...folder, workspaceId, quiet });
        bucket.threads.push(...all);
        bucket.snoozed.push(...snoozed);
      }
    }
    for (const bucket of byWorkspace.values()) {
      bucket.folders = [
        ...sortWorkspaceProjects(
          bucket.folders.filter((folder) => !folder.isScratch),
          projectOrderOf(config, bucket.workspace.id),
          (folder) => ({
            projectKey: folder.group.projectKey,
            createdAt: folder.group.createdAt ?? null,
          }),
        ),
        ...bucket.folders.filter((folder) => folder.isScratch),
      ];
      bucket.snoozed = sortSnoozedThreads(bucket.snoozed);
    }
    return {
      byWorkspace,
      pinned: sortPinnedThreadsForSidebar(pinned),
      workspaceIdsByProjectKey,
      scratchProjectKeys,
      groupByPhysical,
      agentsByRoot: agents.agentsByRoot,
    };
  })();

  /** Every workspace that shows the thread's project. */
  const workspacesOfThread = (
    thread: Pick<SidebarThreadSummary, "environmentId" | "projectId">,
  ): readonly string[] => {
    const group = model.groupByPhysical.get(`${thread.environmentId}:${thread.projectId}`);
    return group ? (model.workspaceIdsByProjectKey.get(group.projectKey) ?? []) : [];
  };
  /** Whether a workspace shows the thread: pinned threads show everywhere. */
  const isShownIn = (thread: SidebarThreadSummary, workspaceId: string) =>
    thread.pinnedAt != null || workspacesOfThread(thread).includes(workspaceId);

  const threadByKey = new Map(threads.map((thread) => [threadKeyOf(thread), thread] as const));
  const routeThread = routeThreadKey ? (threadByKey.get(routeThreadKey) ?? null) : null;
  // The thread holding this client's voice conversation sits on top of the
  // list, in every view, instead of in its usual place.
  const voiceThread = (() => {
    const thread = voiceThreadRef ? threadByKey.get(scopedThreadKey(voiceThreadRef)) : undefined;
    return thread && thread.archivedAt === null ? thread : null;
  })();
  const voiceThreadKey = voiceThread ? threadKeyOf(voiceThread) : null;
  const withoutVoiceThread = (threads: SidebarThreadSummary[]) =>
    voiceThreadKey === null
      ? threads
      : threads.filter((thread) => threadKeyOf(thread) !== voiceThreadKey);
  const routeTargetThread = routeThread ?? routeDraftThread;
  const routePinned = routeThread?.pinnedAt != null;
  const routeWorkspaceIds = routeTargetThread ? workspacesOfThread(routeTargetThread) : [];
  const routeWorkspacesKey = routeWorkspaceIds.join("\n");

  // ── Active workspace ──────────────────────────────────────────────────
  const workspaceIds = config.workspaces.map((workspace) => workspace.id);
  const defaultWorkspaceId = effectiveDefaultWorkspaceId(config);
  const activeWorkspaceId =
    view.activeWorkspaceId !== null && workspaceIds.includes(view.activeWorkspaceId)
      ? view.activeWorkspaceId
      : (defaultWorkspaceId ?? IMPLICIT_WORKSPACE.id);
  const activeWorkspace =
    config.workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;

  // A thread the open workspace shows (its project is there, or it is pinned)
  // opens in place, and the workspace remembers it for the next switch.
  // Opening one from elsewhere (notification, palette, phone) follows it into
  // the first workspace that shows it.
  const lastFollowedRouteRef = useRef<string | null>(null);
  const followRoute = useEffectEvent(() => {
    if (!routeTargetThread) return;
    const followKey = routeThreadKey ?? routeProjectKey;
    if (routePinned || routeWorkspaceIds.includes(activeWorkspaceId)) {
      if (routeThreadKey) view.rememberThread(activeWorkspaceId, routeThreadKey);
      lastFollowedRouteRef.current = followKey;
      return;
    }
    const target = routeWorkspaceIds[0];
    if (!target) return;
    if (routeThreadKey) view.rememberThread(target, routeThreadKey);
    if (followKey === lastFollowedRouteRef.current) return;
    lastFollowedRouteRef.current = followKey;
    view.setActiveWorkspace(target);
  });
  useEffect(() => {
    followRoute();
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Only route changes drive this; switching tiles must not bounce back.
    routeThreadKey,
    routeProjectKey,
    routeWorkspacesKey,
    routePinned,
  ]);

  const navigateToThread = (threadRef: ScopedThreadRef) => {
    if (isMobile) setOpenMobile(false);
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };

  const switchWorkspace = (workspaceId: string) => {
    if (workspaceId === activeWorkspaceId) return;
    view.setActiveWorkspace(workspaceId);
    lastFollowedRouteRef.current = routeThreadKey ?? routeProjectKey;
    const remembered = view.lastThreadByWorkspace[workspaceId];
    const thread = remembered ? threadByKey.get(remembered) : undefined;
    if (thread && thread.archivedAt === null && isShownIn(thread, workspaceId)) {
      lastFollowedRouteRef.current = remembered ?? null;
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    }
  };

  /** A workspace as shown on its own: all pinned threads, then its folders. */
  const withPinned = (bucket: WorkspaceModel): WorkspaceModel => ({
    ...bucket,
    pinned: model.pinned,
  });

  // ── Search ────────────────────────────────────────────────────────────
  // Folder drag within a workspace: the lifted folder and the line it would land on.
  const [folderDrag, setFolderDrag] = useState<{ workspaceId: string; projectKey: string } | null>(
    null,
  );
  const [folderDrop, setFolderDrop] = useState<{ projectKey: string; after: boolean } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isSearching = searchQuery.trim().length > 0;
  const searchScopeAll = !view.tilesVisible;
  const searchResults = (() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    const results: { thread: SidebarThreadSummary; folder: FolderModel }[] = [];
    const seenProjects = new Set<string>();
    const folders = [...model.byWorkspace.values()]
      .filter((bucket) => searchScopeAll || bucket.workspace.id === activeWorkspaceId)
      .flatMap((bucket) => bucket.folders)
      // A project in several workspaces is searched once.
      .filter((folder) => {
        if (seenProjects.has(folder.group.projectKey)) return false;
        seenProjects.add(folder.group.projectKey);
        return true;
      });
    for (const folder of folders) {
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
    return results.toSorted(
      (left, right) => threadActivityMs(right.thread) - threadActivityMs(left.thread),
    );
  })();

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
  // The top-level thread whose agents hold the open route, so its group opens.
  const routeRootKey = (() => {
    if (!routeThreadKey) return null;
    for (const [rootKey, agents] of model.agentsByRoot) {
      if (agents.some((agent) => threadKeyOf(agent) === routeThreadKey)) return rootKey;
    }
    return null;
  })();
  // "Show agents" / "Hide agents" once a thread's agents are all done.
  const menuAgents = (() => {
    if (!menuRequest) return null;
    const rootKey = scopedThreadKey(menuRequest.ref);
    const agents = model.agentsByRoot.get(rootKey);
    if (!agents || rootKey === routeRootKey) return null;
    const summary = summarizeThreadAgents(agents);
    if (threadAgentsLive(summary)) return null;
    const choiceKey = threadAgentsChoiceKey(rootKey, summary);
    const display = threadAgentsDisplay(summary, {
      holdsRoute: false,
      choice: view.sectionOpen[choiceKey],
    });
    return {
      count: summary.total,
      shown: display !== "hidden",
      setShown: (shown: boolean) => view.setSectionOpen(choiceKey, shown),
    };
  })();
  const canShareMenuThreadWithGuest = useAtomValue(
    canShareWithGuestAtom(menuRequest?.ref.environmentId ?? ("" as EnvironmentId)),
  );
  const { openMenu } = useThreadActionMenu({
    agents: menuAgents,
    canShareWithGuest: canShareMenuThreadWithGuest,
    threadRef: menuRequest?.ref ?? null,
    projectCwd: menuThread,
    onStartRename: () => {
      if (menuRequest) setRenamingKey(scopedThreadKey(menuRequest.ref));
    },
  });
  const openRequestedMenu = useEffectEvent(() => {
    if (menuRequest) openMenu(menuRequest.position);
  });
  useEffect(() => {
    openRequestedMenu();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new request (nonce) opens the menu once.
  }, [menuRequest?.nonce]);
  const handleThreadContextMenu = (ref: ScopedThreadRef, position: { x: number; y: number }) => {
    setMenuRequest((previous) => ({ ref, position, nonce: (previous?.nonce ?? 0) + 1 }));
  };
  const handleTogglePin = (thread: SidebarThreadSummary) => {
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    void (thread.pinnedAt != null
      ? reportFailure("Failed to unpin thread", () => confirmAndUnpinThread(ref))
      : reportFailure("Failed to pin thread", () => pinThread(ref)));
  };
  const handleSettle = (ref: ScopedThreadRef) =>
    void reportFailure("Failed to settle thread", () => settleThread(ref));
  const handleUnsettle = (ref: ScopedThreadRef) =>
    void reportFailure("Failed to un-settle thread", () => unsettleThread(ref));
  const handleWake = (ref: ScopedThreadRef) =>
    void reportFailure("Failed to wake thread", () => unsnoozeThread(ref));
  const handleCommitRename = (ref: ScopedThreadRef, title: string | null) => {
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
  };
  const startThreadInFolder = (folder: FolderModel) => {
    const member =
      folder.group.memberProjects.find(
        (project) => project.environmentId === primaryEnvironmentId,
      ) ?? folder.group.memberProjects[0];
    if (!member) return;
    if (isMobile) setOpenMobile(false);
    void handleNewThread(scopeProjectRef(member.environmentId, member.id)).catch((error) =>
      failureToast("Could not create thread", error),
    );
  };

  // ── Workspace edits ───────────────────────────────────────────────────
  const [editingWorkspace, setEditingWorkspace] = useState<WorkspaceTitleEditing>(null);
  const createWorkspace = () => {
    const added = addWorkspace(config).config.workspaces;
    const workspace = added[added.length - 1]!;
    const { id } = workspace;
    writeConfig((config) => ({ ...config, workspaces: [...config.workspaces, workspace] }));
    view.setActiveWorkspace(id);
    setEditingWorkspace("name");
  };
  const renameWorkspace = (workspaceId: string, name: string | null) => {
    setEditingWorkspace(null);
    const trimmed = name?.trim();
    if (!trimmed) return;
    writeConfig((config) => updateWorkspace(config, workspaceId, { name: trimmed }));
  };
  /** `undefined` resets the tile to the name's first letter. */
  const setWorkspaceIcon = (workspaceId: string, icon: string | undefined) => {
    writeConfig((config) => updateWorkspace(config, workspaceId, { icon: icon ?? null }));
  };
  const commitWorkspaceLabel = (workspaceId: string, label: string | null) => {
    setEditingWorkspace(null);
    if (label === null) return;
    setWorkspaceIcon(workspaceId, normalizeWorkspaceLabel(label) ?? undefined);
  };
  const reorderWorkspace = (workspaceId: string, beforeIndex: number) => {
    writeConfig((config) => ({
      ...config,
      workspaces: [...reorderWorkspaces(config.workspaces, workspaceId, beforeIndex)],
    }));
  };
  const identityOfProject = (projectKey: string) => {
    const group = projectGroups.find((candidate) => candidate.projectKey === projectKey);
    return group ? projectIdentity(group, model.scratchProjectKeys.has(projectKey)) : null;
  };
  /** A workspace's projects as shown, so a project added there lands on top. */
  const sequenceOf = (workspaceId: string) =>
    (model.byWorkspace.get(workspaceId)?.folders ?? [])
      .filter((folder) => !folder.isScratch)
      .map((folder) => folder.group.projectKey);
  /** "Show in workspaces": ticks or unticks one workspace (never the last). */
  const toggleProjectIn = (projectKey: string, workspaceId: string) => {
    const project = identityOfProject(projectKey);
    if (project) {
      writeConfig((config) => toggleProjectWorkspace(config, project, workspaceId, sequenceOf));
    }
  };
  const openWorkspaceMenu = async (workspaceId: string, position: { x: number; y: number }) => {
    const api = readLocalApi();
    const current = config;
    const index = current.workspaces.findIndex((entry) => entry.id === workspaceId);
    const workspace = current.workspaces[index];
    if (!api || !workspace) return;
    const isDefault = effectiveDefaultWorkspaceId(current) === workspaceId;
    const currentIcon = workspace.icon ?? "";
    const items: ContextMenuItem[] = [
      { id: "rename", label: "Rename", icon: "pencil" },
      {
        id: "icon",
        label: "Icon",
        children: [
          { id: "icon:label", label: "Letters or emoji…" },
          ...Object.entries(WORKSPACE_GLYPHS).map(([key, glyph], glyphIndex) => ({
            id: `icon:glyph:${key}`,
            label: glyph.label,
            checked: currentIcon === `${WORKSPACE_GLYPH_PREFIX}${key}`,
            separatorBefore: glyphIndex === 0,
          })),
          {
            id: "icon:reset",
            label: "First letter of the name",
            checked: currentIcon === "",
            separatorBefore: true,
          },
        ],
      },
      {
        id: "color",
        label: "Color",
        children: WORKSPACE_COLORS.map((color, colorIndex) => ({
          id: `color:${color}`,
          label:
            ["Blue", "Coral", "Green", "Violet", "Amber", "Teal", "Rose", "Olive"][colorIndex] ??
            color,
          checked: workspaceColor(workspace) === color,
        })),
      },
      {
        id: "move-left",
        label: "Move left",
        disabled: index === 0,
        separatorBefore: true,
      },
      {
        id: "move-right",
        label: "Move right",
        disabled: index === current.workspaces.length - 1,
      },
      {
        id: "default",
        label: "Default for new projects",
        checked: isDefault,
        separatorBefore: true,
      },
      isDefault
        ? {
            id: "delete-blocked",
            label: "Default workspace can't be deleted",
            disabled: true,
            separatorBefore: true,
          }
        : {
            id: "delete",
            label: "Delete workspace",
            icon: "trash",
            destructive: true,
            separatorBefore: true,
          },
    ];
    const clicked = await api.contextMenu.show(items, position);
    if (!clicked) return;
    if (clicked === "rename" || clicked === "icon:label") {
      view.setActiveWorkspace(workspaceId);
      setEditingWorkspace(clicked === "rename" ? "name" : "label");
    } else if (clicked.startsWith("icon:glyph:")) {
      setWorkspaceIcon(
        workspaceId,
        `${WORKSPACE_GLYPH_PREFIX}${clicked.slice("icon:glyph:".length)}`,
      );
    } else if (clicked === "icon:reset") {
      setWorkspaceIcon(workspaceId, undefined);
    } else if (clicked.startsWith("color:")) {
      const color = clicked.slice("color:".length);
      writeConfig((config) => updateWorkspace(config, workspaceId, { color }));
    } else if (clicked === "move-left") {
      reorderWorkspace(workspaceId, index - 1);
    } else if (clicked === "move-right") {
      reorderWorkspace(workspaceId, index + 2);
    } else if (clicked === "default") {
      writeConfig((config) => ({ ...config, defaultWorkspace: workspaceId }));
    } else if (clicked === "delete") {
      const confirmed = await api.dialogs.confirm(
        `Delete workspace "${workspace.name}"? Its projects move to the default workspace; no threads are deleted.`,
      );
      if (!confirmed) return;
      writeConfig((config) => deleteWorkspace(config, workspaceId));
      if (activeWorkspaceId === workspaceId) view.setActiveWorkspace(null);
    }
  };
  // Project icons are the project's own setting (same as Project settings ›
  // Icon), written to every checkout of the folder.
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const [iconPickerFolder, setIconPickerFolder] = useState<FolderModel | null>(null);
  const setFolderIcon = async (folder: FolderModel, projectIcon: ProjectIconOverride | null) => {
    for (const member of folder.group.memberProjects) {
      await reportFailure("Failed to update project icon", () =>
        updateProject({
          environmentId: member.environmentId,
          input: { projectId: member.id, faviconPath: null, projectIcon },
        }),
      );
    }
  };
  const openFolderMenu = async (folder: FolderModel, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const projectKey = folder.group.projectKey;
    const foldMode = projectFoldModeOf(config, folder.workspaceId, projectKey);
    const hasCustomIcon = folder.group.memberProjects.some(
      (member) => member.projectIcon != null || member.faviconPath != null,
    );
    const shownIn = model.workspaceIdsByProjectKey.get(projectKey) ?? [];
    const placement: ContextMenuItem[] = [
      {
        id: "show-in",
        label: "Show in workspaces",
        icon: "folder",
        // The last workspace can't be unticked: a project always shows somewhere.
        children: config.workspaces.map((workspace) => ({
          id: `show:${workspace.id}`,
          label: workspace.name,
          checked: shownIn.includes(workspace.id),
          disabled: shownIn.length === 1 && shownIn[0] === workspace.id,
        })),
      },
      // "No project" is never quiet.
      ...(folder.isScratch
        ? []
        : [
            folder.quiet
              ? { id: "fold:active", label: "Move to active projects" }
              : { id: "fold:quiet", label: "Move to quiet projects" },
            ...(foldMode === "auto" ? [] : [{ id: "fold:auto", label: "Fold automatically" }]),
          ]),
    ];
    const items: ContextMenuItem[] = [
      { id: "new-thread", label: "New thread", icon: "message-square-plus" },
      ...placement,
      { id: "icon", label: "Icon…", icon: "smile", separatorBefore: true },
      ...(hasCustomIcon ? [{ id: "icon-reset", label: "Reset icon" }] : []),
      { id: "settings", label: "Project settings", icon: "settings", separatorBefore: true },
    ];
    const clicked = await api.contextMenu.show(items, position);
    if (!clicked) return;
    if (clicked === "new-thread") startThreadInFolder(folder);
    else if (clicked === "icon") setIconPickerFolder(folder);
    else if (clicked === "icon-reset") void setFolderIcon(folder, null);
    else if (clicked.startsWith("show:"))
      toggleProjectIn(projectKey, clicked.slice("show:".length));
    else if (clicked.startsWith("fold:")) {
      const mode = clicked.slice("fold:".length) as ProjectFoldMode;
      writeConfig((config) => setProjectFoldMode(config, folder.workspaceId, projectKey, mode));
    } else if (clicked === "settings") {
      if (isMobile) setOpenMobile(false);
      void router.navigate({ to: "/projects/$projectKey", params: { projectKey } });
    }
  };

  // ── Ordered rows for jump / traversal shortcuts ───────────────────────
  const activeBucket = model.byWorkspace.get(activeWorkspaceId);
  const visibleWorkspaces: ThreadListModel[] = view.tilesVisible
    ? activeBucket
      ? [withPinned(activeBucket)]
      : []
    : [{ pinned: model.pinned, folders: [] }, ...model.byWorkspace.values()];
  const orderedThreadKeys = (() => {
    if (isSearching) return searchResults.map(({ thread }) => threadKeyOf(thread));
    // A Set: in the all-workspaces list a project can show more than once.
    const keys = new Set<string>(voiceThreadKey === null ? [] : [voiceThreadKey]);
    for (const bucket of visibleWorkspaces) {
      for (const thread of bucket.pinned) keys.add(threadKeyOf(thread));
      for (const folder of bucket.folders) {
        if (folder.quiet) continue;
        const open = view.folderOpen[`${folder.workspaceId}:${folder.group.projectKey}`] ?? true;
        if (!open) continue;
        for (const thread of folder.active.slice(0, FOLDER_PREVIEW_COUNT))
          keys.add(threadKeyOf(thread));
      }
    }
    return [...keys];
  })();
  const jumpLabelByKey = new Map(
    orderedThreadKeys.slice(0, 9).map((key, index) => [key, String(index + 1)]),
  );
  const [showJumpHints, setShowJumpHints] = useState(false);

  // ── Keyboard ──────────────────────────────────────────────────────────
  const onShortcutKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || isCommandPaletteOpen() || isModelPickerOpen()) return;
    if (event.altKey && !event.ctrlKey && !event.metaKey && /^Digit[0-9]$/.test(event.code)) {
      const digit = Number(event.code.slice(5));
      event.preventDefault();
      if (digit === 0) {
        view.toggleTiles();
        return;
      }
      const target = config.workspaces[digit - 1];
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
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => onShortcutKeyDown(event);
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
  }, []);

  // ── Activity per workspace (tiles) ────────────────────────────────────
  const seenBaselineAt = useWorkspaceViewStore((state) => state.seenBaselineAt);
  const ensureSeenBaseline = useWorkspaceViewStore((state) => state.ensureSeenBaseline);
  useEffect(ensureSeenBaseline, [ensureSeenBaseline]);
  const isUnreadThread = (thread: SidebarThreadSummary) =>
    isThreadUnread(thread, lastVisitedById[threadKeyOf(thread)], seenBaselineAt);
  const tileEntries: WorkspaceTileEntry[] = config.workspaces.map((workspace) => {
    const bucket = model.byWorkspace.get(workspace.id);
    return {
      workspace,
      activity: bucket
        ? summarizeWorkspaceActivity(bucket.threads, isUnreadThread)
        : EMPTY_WORKSPACE_ACTIVITY,
    };
  });

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
  const holdsRoute = (thread: SidebarThreadSummary) => {
    const key = threadKeyOf(thread);
    return key === routeThreadKey || key === routeRootKey;
  };
  /** A thread row and, under it, the agents it launched. */
  const renderThread = (
    thread: SidebarThreadSummary,
    variant: WorkspaceRowVariant,
    projectLabel?: string | null,
  ) => {
    const key = threadKeyOf(thread);
    if (key === voiceThreadKey && variant !== "voice") return null;
    const agents = model.agentsByRoot.get(key);
    if (!agents) return renderRow(thread, variant, projectLabel);
    const summary = summarizeThreadAgents(agents);
    const choiceKey = threadAgentsChoiceKey(key, summary);
    const display = threadAgentsDisplay(summary, {
      holdsRoute: routeRootKey === key,
      choice: view.sectionOpen[choiceKey],
    });
    if (display === "hidden") return renderRow(thread, variant, projectLabel);
    const open = display === "open";
    return (
      <Fragment key={key}>
        {renderRow(thread, variant, projectLabel)}
        <WorkspaceAgentGroup
          summary={summary}
          dotKeys={agents.map(threadKeyOf)}
          open={open}
          onToggle={() => view.setSectionOpen(choiceKey, !open)}
        >
          {agents.map((agent) => renderRow(agent, "agent"))}
        </WorkspaceAgentGroup>
      </Fragment>
    );
  };
  const labelOfThread = (thread: SidebarThreadSummary) => {
    const group = model.groupByPhysical.get(`${thread.environmentId}:${thread.projectId}`);
    if (!group) return null;
    return model.scratchProjectKeys.has(group.projectKey) ? SCRATCH_LABEL : group.displayName;
  };
  const voiceRow = voiceThread ? (
    <div className="mb-1 flex flex-col">
      {renderThread(voiceThread, "voice", labelOfThread(voiceThread))}
    </div>
  ) : null;

  /** Drops the dragged folder next to `target`, in that workspace's own order. */
  const dropFolder = (target: FolderModel, after: boolean) => {
    const dragged = folderDrag?.projectKey;
    const bucket = model.byWorkspace.get(target.workspaceId);
    if (!dragged || !bucket || dragged === target.group.projectKey) return;
    const sequence = bucket.folders
      .filter((folder) => !folder.isScratch)
      .map((folder) => folder.group.projectKey);
    const rest = sequence.filter((key) => key !== dragged);
    const beforeKey = after
      ? (rest[rest.indexOf(target.group.projectKey) + 1] ?? null)
      : target.group.projectKey;
    // Dropped among the other section's folders, it moves into that section by hand.
    const draggedFolder = bucket.folders.find((folder) => folder.group.projectKey === dragged);
    const crosses = draggedFolder !== undefined && draggedFolder.quiet !== target.quiet;
    writeConfig((current) => {
      const moved = moveProjectInWorkspace(
        current,
        target.workspaceId,
        sequence,
        dragged,
        beforeKey,
      );
      return crosses
        ? setProjectFoldMode(moved, target.workspaceId, dragged, target.quiet ? "quiet" : "active")
        : moved;
    });
  };
  /** A loud folder dropped on the "Quiet projects" header moves there by hand. */
  const quietDropOf = (bucket: WorkspaceModel) => {
    if (folderDrag === null || folderDrag.workspaceId !== bucket.workspace.id) return null;
    const dragged = bucket.folders.find(
      (folder) => folder.group.projectKey === folderDrag.projectKey,
    );
    if (!dragged || dragged.isScratch || dragged.quiet) return null;
    return () =>
      writeConfig((current) =>
        setProjectFoldMode(current, bucket.workspace.id, dragged.group.projectKey, "quiet"),
      );
  };
  /** A folder dropped on a tile moves there, or with Ctrl shows there as well. */
  const dropProjectOnTile = (projectKey: string, workspaceId: string, add: boolean) => {
    const project = identityOfProject(projectKey);
    if (!project) return;
    const fromWorkspaceId = folderDrag?.workspaceId ?? activeWorkspaceId;
    writeConfig((current) =>
      dropProjectOnWorkspace(current, project, {
        fromWorkspaceId,
        toWorkspaceId: workspaceId,
        add,
        sequenceOf,
      }),
    );
  };

  const renderFolder = (folder: FolderModel) => {
    const folderKey = `${folder.workspaceId}:${folder.group.projectKey}`;
    const dropAt = folderDrop?.projectKey === folder.group.projectKey ? folderDrop : null;
    // "No project" stays last, so it neither takes nor makes a place in the order.
    const acceptsDrop =
      folderDrag !== null &&
      !folder.isScratch &&
      !model.scratchProjectKeys.has(folderDrag.projectKey) &&
      folderDrag.workspaceId === folder.workspaceId &&
      folderDrag.projectKey !== folder.group.projectKey;
    const open = view.folderOpen[folderKey] ?? !folder.quiet;
    const expanded = view.folderExpanded[folderKey] ?? false;
    const settledOpen = view.settledOpen[folderKey] ?? false;
    let visible = folder.active;
    if (!expanded && visible.length > FOLDER_PREVIEW_COUNT) {
      visible = visible.slice(0, FOLDER_PREVIEW_COUNT);
      const activeRow = folder.active.find((thread) => holdsRoute(thread));
      if (activeRow && !visible.includes(activeRow)) visible = [...visible, activeRow];
    }
    const collapsedActive = !open ? folder.active.find((thread) => holdsRoute(thread)) : undefined;
    const attention = folder.all.filter(needsAttention).length;
    const working = folder.all.filter(
      (thread) => resolveSidebarThreadStatus(thread) === "working",
    ).length;
    return (
      <div key={folderKey} className="flex flex-col">
        <Tooltip disabled={folderDrag !== null}>
          <TooltipTrigger
            render={
              <div
                role="button"
                tabIndex={0}
                draggable
                aria-expanded={open}
                className="group/ws-folder relative flex h-7 cursor-pointer select-none items-center gap-1.5 rounded-md pr-1 pl-1 text-sm font-medium text-sidebar-foreground outline-hidden transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
                  event.dataTransfer.effectAllowed = "copyMove";
                  setFolderDrag({
                    workspaceId: folder.workspaceId,
                    projectKey: folder.group.projectKey,
                  });
                }}
                onDragEnd={() => {
                  setFolderDrag(null);
                  setFolderDrop(null);
                }}
                onDragOver={(event) => {
                  if (!acceptsDrop) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  const rect = event.currentTarget.getBoundingClientRect();
                  const after = event.clientY > rect.top + rect.height / 2;
                  if (dropAt?.after !== after) {
                    setFolderDrop({ projectKey: folder.group.projectKey, after });
                  }
                }}
                onDragLeave={(event) => {
                  if (dropAt && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setFolderDrop(null);
                  }
                }}
                onDrop={(event) => {
                  if (!acceptsDrop) return;
                  event.preventDefault();
                  dropFolder(folder, dropAt?.after ?? false);
                  setFolderDrag(null);
                  setFolderDrop(null);
                }}
              />
            }
          >
            {dropAt ? (
              <span
                className={cn(
                  "pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary",
                  dropAt.after ? "-bottom-px" : "-top-px",
                )}
              />
            ) : null}
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
              <span className="flex shrink-0 items-center gap-1.5 text-2xs font-semibold tabular-nums group-hover/ws-folder:hidden">
                {attention > 0 ? (
                  <span className="text-warning-foreground">◆{attention}</span>
                ) : null}
                {working > 0 ? <span className="text-info-foreground">●{working}</span> : null}
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
          </TooltipTrigger>
          <TooltipPopup side="right" align="start">
            {folder.group.memberProjects.map((member) => (
              <div key={member.workspaceRoot} className="min-w-0 wrap-anywhere">
                {member.workspaceRoot}
              </div>
            ))}
          </TooltipPopup>
        </Tooltip>
        {open ? (
          <div className="flex flex-col pl-3">
            {visible.map((thread) => renderThread(thread, "active"))}
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
                      .map((thread) => renderThread(thread, "settled"))
                  : null}
                <MoreButton onClick={() => view.toggleSettledOpen(folderKey)}>
                  {settledOpen ? "Hide settled" : `${folder.settled.length} settled`}
                </MoreButton>
              </>
            ) : null}
          </div>
        ) : collapsedActive ? (
          <div className="flex flex-col pl-3">{renderThread(collapsedActive, "active")}</div>
        ) : null}
      </div>
    );
  };

  const renderWorkspaceBody = (bucket: WorkspaceModel, nested: boolean) => {
    const loud = bucket.folders.filter((folder) => !folder.quiet && !folder.isScratch);
    const quiet = bucket.folders.filter((folder) => folder.quiet);
    const scratch = bucket.folders.filter((folder) => folder.isScratch);
    const quietKey = `quiet:${bucket.workspace.id}`;
    const quietHoldsActive = quiet.some((folder) =>
      folder.all.some((thread) => threadKeyOf(thread) === routeThreadKey),
    );
    const quietOpen = (view.sectionOpen[quietKey] ?? false) || quietHoldsActive;
    const snoozedKey = `snoozed:${bucket.workspace.id}`;
    const snoozedOpen = view.sectionOpen[snoozedKey] ?? false;
    const quietDrop = quietDropOf(bucket);
    const pinned = withoutVoiceThread(bucket.pinned);
    return (
      <div className="flex flex-col gap-0.5">
        {nested ? null : voiceRow}
        {!nested && pinned.length > 0 ? (
          <Section icon={<PinIcon className="size-3" />} label="Pinned">
            {pinned.map((thread) => renderThread(thread, "pinned", labelOfThread(thread)))}
          </Section>
        ) : null}
        {loud.length === 0 && quiet.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs leading-relaxed text-sidebar-muted-foreground">
            No projects in{" "}
            <span className="font-medium text-sidebar-foreground">{bucket.workspace.name}</span>{" "}
            yet.
            <br />
            Drag a project folder onto this tile (hold Ctrl to keep it where it is too), or use
            “Show in workspaces” in a folder menu.
          </div>
        ) : null}
        {loud.map(renderFolder)}
        {quiet.length > 0 || quietDrop !== null ? (
          <CollapsibleSection
            label="Quiet projects"
            count={quiet.length}
            open={quietOpen}
            title={`No activity for ${config.quietAfterDays}+ days, or moved here by hand`}
            onToggle={() => view.setSectionOpen(quietKey, !quietOpen)}
            onDropFolder={quietDrop}
          >
            {quiet.map(renderFolder)}
          </CollapsibleSection>
        ) : null}
        {scratch.map(renderFolder)}
        {!nested && bucket.snoozed.length > 0 ? (
          <CollapsibleSection
            icon={<AlarmClockIcon className="size-3" />}
            label="Snoozed"
            count={bucket.snoozed.length}
            open={snoozedOpen}
            onToggle={() => view.setSectionOpen(snoozedKey, !snoozedOpen)}
          >
            {bucket.snoozed.map((thread) => renderThread(thread, "snoozed", labelOfThread(thread)))}
          </CollapsibleSection>
        ) : null}
      </div>
    );
  };

  const renderAllWorkspaces = () => {
    const allPinned = withoutVoiceThread(model.pinned);
    const allSnoozed = sortSnoozedThreads([
      ...new Map(
        [...model.byWorkspace.values()]
          .flatMap((bucket) => bucket.snoozed)
          .map((thread) => [threadKeyOf(thread), thread] as const),
      ).values(),
    ]);
    const snoozedOpen = view.sectionOpen["snoozed:all"] ?? false;
    return (
      <div className="flex flex-col gap-1">
        {voiceRow}
        {allPinned.length > 0 ? (
          <Section icon={<PinIcon className="size-3" />} label="Pinned">
            {allPinned.map((thread) => renderThread(thread, "pinned", labelOfThread(thread)))}
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
                className="mt-1 flex h-7 items-center gap-2 rounded-md px-1 text-left text-xs font-semibold tracking-tight text-sidebar-foreground outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
                  <span className="text-2xs text-warning-foreground">◆{activity.attention}</span>
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
            {allSnoozed.map((thread) => renderThread(thread, "snoozed", labelOfThread(thread)))}
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
          className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-linear-to-b from-(--ws-accent)/13 to-transparent"
        />
      ) : null}
      <WorkspaceTitlebar
        workspace={headerWorkspace}
        isElectron={isElectron}
        editing={headerWorkspace !== null ? editingWorkspace : null}
        onStartRename={() => setEditingWorkspace("name")}
        onCommitRename={(name) => headerWorkspace && renameWorkspace(headerWorkspace.id, name)}
        onCommitLabel={(label) =>
          headerWorkspace && commitWorkspaceLabel(headerWorkspace.id, label)
        }
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
            {talk ? (
              <SidebarHeaderIconButton
                label="Talk in a new thread"
                onClick={() => {
                  if (isMobile) setOpenMobile(false);
                  talk();
                }}
              >
                <AudioLinesIcon />
              </SidebarHeaderIconButton>
            ) : null}
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
      <SidebarContent className="relative">
        <div className="flex flex-col px-2 pb-2">
          {isSearching
            ? renderSearch()
            : view.tilesVisible
              ? (() => {
                  const bucket = model.byWorkspace.get(activeWorkspaceId);
                  return bucket ? renderWorkspaceBody(withPinned(bucket), false) : null;
                })()
              : renderAllWorkspaces()}
        </div>
      </SidebarContent>
      <WorkspaceUpdateStrip />
      <WorkspaceDock
        entries={tileEntries}
        activeWorkspaceId={activeWorkspaceId}
        defaultWorkspaceId={defaultWorkspaceId}
        tilesVisible={view.tilesVisible}
        onSelect={switchWorkspace}
        onTileContextMenu={(workspaceId, position) => void openWorkspaceMenu(workspaceId, position)}
        onCreate={createWorkspace}
        onToggleTiles={view.toggleTiles}
        onDropProject={dropProjectOnTile}
        onReorder={reorderWorkspace}
      />
      <SidebarChromeFooter />
      {iconPickerFolder ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={iconPickerFolder.group.memberProjects[0]?.projectIcon ?? null}
            projectName={iconPickerFolder.group.memberProjects[0]?.title ?? iconPickerFolder.label}
            open
            onOpenChange={(open) => {
              if (!open) setIconPickerFolder(null);
            }}
            onSelect={(icon) => void setFolderIcon(iconPickerFolder, icon)}
          />
        </Suspense>
      ) : null}
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
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className="flex size-5 items-center justify-center rounded text-sidebar-muted-foreground transition-colors hover:bg-foreground/8 hover:text-sidebar-foreground [&_svg]:size-3.5"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onClick({ x: event.clientX, y: event.clientY });
            }}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function MoreButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="flex h-6 items-center gap-1.5 rounded-md pl-7.5 text-left text-xs text-sidebar-muted-foreground outline-hidden transition-colors hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
      <div className="flex h-6 items-center gap-1.5 px-2 text-2xs font-medium tracking-wide text-sidebar-muted-foreground uppercase">
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
  onDropFolder,
  children,
}: {
  icon?: ReactNode;
  label: string;
  count: number;
  open: boolean;
  title?: string;
  onToggle: () => void;
  /** Set while a folder that may drop here is dragged. */
  onDropFolder?: (() => void) | null;
  children: ReactNode;
}) {
  const [dropOver, setDropOver] = useState(false);
  return (
    <div className="mt-1 flex flex-col">
      <Tooltip disabled={!title}>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-expanded={open}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-md px-1 text-left text-2xs font-medium tracking-wide text-sidebar-muted-foreground uppercase outline-hidden transition-colors hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                onDropFolder && "outline-1 -outline-offset-1 outline-dashed outline-sidebar-border",
                onDropFolder &&
                  dropOver &&
                  "bg-sidebar-row-hover text-sidebar-foreground outline-primary",
              )}
              onClick={onToggle}
              onDragOver={(event) => {
                if (!onDropFolder) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (!dropOver) setDropOver(true);
              }}
              onDragLeave={() => setDropOver(false)}
              onDrop={(event) => {
                setDropOver(false);
                if (!onDropFolder) return;
                event.preventDefault();
                onDropFolder();
              }}
            />
          }
        >
          <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          {icon}
          <span>{label}</span>
          <span className="ml-auto pr-1 tabular-nums">{count}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">{title}</TooltipPopup>
      </Tooltip>
      {open ? <div className="flex flex-col">{children}</div> : null}
    </div>
  );
}
