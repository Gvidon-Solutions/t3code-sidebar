import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import {
  type AgentRunState,
  groupThreadAgents,
  summarizeThreadAgents,
  threadAgentsLabel,
  threadAgentsChoiceKey,
  threadAgentsDisplay,
} from "@t3tools/client-runtime/state/thread-agents";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  sortWorkspaceProjects,
  type ProjectFoldMode,
} from "@t3tools/client-runtime/state/sidebar-workspaces";
import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  toSortableTimestamp,
} from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  resolveThreadListV2Status,
  resolveThreadListV2WokeAt,
  threadListV2ListItemsAreEqual,
  type ThreadListV2Item,
  type ThreadListV2ListItem,
  type ThreadListV2ThreadListItem,
} from "../threads/threadListV2";

/**
 * Home in workspace mode (sidebar fork), with the desktop's partition and order rules
 * (`WorkspaceSidebar.tsx`): pinned threads, project folders in the user's order, quiet projects
 * in one group, "No project", snoozed threads last.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const FOLDER_PREVIEW_COUNT = 8;

export interface WorkspaceFolderInput {
  readonly projectKey: string;
  readonly title: string;
  readonly project: EnvironmentProject;
  readonly projectCreatedAt: string | null;
  /** `environmentId:projectId` of every member project. */
  readonly memberKeys: ReadonlyArray<string>;
  /** The environment's "No project" folder: never quiet, always last. */
  readonly isScratch: boolean;
  /** Every workspace the project shows in, for the folder's "Show in workspaces". */
  readonly workspaceIds?: ReadonlyArray<string>;
}

export type WorkspaceSectionKind = "pinned" | "quiet" | "snoozed";

export interface WorkspaceSectionListItem {
  readonly type: "ws-section";
  readonly key: string;
  readonly kind: WorkspaceSectionKind;
  readonly count: number;
  /** Null for sections that cannot fold (Pinned). */
  readonly toggleKey: string | null;
  readonly open: boolean;
}

export interface WorkspaceFolderListItem {
  readonly type: "ws-folder";
  readonly key: string;
  /** `workspaceId:projectKey`, as on the desktop. */
  readonly folderKey: string;
  readonly projectKey: string;
  readonly title: string;
  readonly project: EnvironmentProject;
  readonly open: boolean;
  readonly quiet: boolean;
  /** Whether the user moved it by hand ("active"/"quiet") or it folds by itself. */
  readonly foldMode: ProjectFoldMode;
  readonly isScratch: boolean;
  /** Every workspace the project shows in. */
  readonly workspaceIds: ReadonlyArray<string>;
  readonly attention: number;
  readonly working: number;
}

export interface WorkspaceMoreListItem {
  readonly type: "ws-more";
  readonly key: string;
  readonly toggleKey: string;
  readonly label: string;
  /** Empty folder: the row starts a thread instead of toggling. */
  readonly newThreadIn?: EnvironmentProject;
}

/** A thread row drawn as one line; `projectLabel` prefixes pinned/snoozed rows. */
export interface WorkspaceThreadListItem extends Omit<ThreadListV2ThreadListItem, "type"> {
  readonly type: "ws-thread";
  readonly projectLabel: string | null;
  /** An agent drawn under the thread that started it. */
  readonly nested?: boolean;
  /** The thread holding this device's voice conversation, drawn first with a wave. */
  readonly voice?: boolean;
}

/** "5 agents · 4 working" under a thread that launched subagents; opens to list them. */
export interface WorkspaceAgentsListItem {
  readonly type: "ws-agents";
  readonly key: string;
  readonly toggleKey: string;
  readonly open: boolean;
  readonly label: string;
  readonly dots: ReadonlyArray<{ readonly key: string; readonly state: AgentRunState }>;
}

export type WorkspaceHomeListItem =
  | ThreadListV2ListItem
  | WorkspaceSectionListItem
  | WorkspaceFolderListItem
  | WorkspaceMoreListItem
  | WorkspaceThreadListItem
  | WorkspaceAgentsListItem;

const threadKey = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
  `${thread.environmentId}:${thread.id}`;

function needsAttention(thread: EnvironmentThreadShell): boolean {
  const status = resolveThreadListV2Status(thread);
  return status === "approval" || status === "input" || status === "failed" || status === "limited";
}

/** Last moment the thread saw activity, as the desktop counts it. */
export function threadActivityMs(thread: EnvironmentThreadShell): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const value of [
    thread.latestRun?.completedAt,
    thread.latestRun?.startedAt,
    thread.latestUserMessageAt,
    thread.createdAt,
  ]) {
    const ms = value ? Date.parse(value) : Number.NaN;
    if (!Number.isNaN(ms) && ms > latest) latest = ms;
  }
  return latest;
}

/** Compact relative label: now, 5m, 3h, 2d, 4w. */
export function compactAgo(ms: number, now: number): string {
  if (!Number.isFinite(ms)) return "";
  const delta = Math.max(0, now - ms);
  const minute = 60_000;
  if (delta < minute) return "now";
  if (delta < 60 * minute) return `${Math.floor(delta / minute)}m`;
  if (delta < DAY_MS) return `${Math.floor(delta / (60 * minute))}h`;
  if (delta < 7 * DAY_MS) return `${Math.floor(delta / DAY_MS)}d`;
  return `${Math.floor(delta / (7 * DAY_MS))}w`;
}

/** Same rule as the desktop: nothing pinned, busy, blocked or recent. */
export function isFolderQuiet(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectCreatedAt: string | null;
  readonly quietAfterDays: number;
  /** A project the user moved by hand stays where they put it. */
  readonly foldMode: ProjectFoldMode;
  readonly now: number;
}): boolean {
  if (input.foldMode !== "auto") return input.foldMode === "quiet";
  const horizon = input.now - input.quietAfterDays * DAY_MS;
  const nowIso = new Date(input.now).toISOString();
  let live = 0;
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    live += 1;
    if (effectiveSnoozed(thread, { now: nowIso })) continue;
    if (thread.settledOverride === "settled") continue;
    if (thread.pinnedAt != null) return false;
    if (needsAttention(thread) || isThreadWorking(thread)) return false;
    if (threadActivityMs(thread) >= horizon) return false;
  }
  if (live === 0) {
    const created = input.projectCreatedAt ? Date.parse(input.projectCreatedAt) : Number.NaN;
    return Number.isNaN(created) || created < horizon;
  }
  return true;
}

/** A folder as the drag overlay lists it. */
export interface ArrangeableFolder {
  readonly projectKey: string;
  readonly title: string;
  readonly project: EnvironmentProject;
  readonly quiet: boolean;
}

/**
 * The open workspace's folders in the user's order, quiet ones included, for
 * the long-press drag. "No project" is left out: it always sits last.
 */
export function arrangeWorkspaceFolders(input: {
  readonly folders: ReadonlyArray<WorkspaceFolderInput>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly quietAfterDays: number;
  readonly foldModeOf: (projectKey: string) => ProjectFoldMode;
  readonly projectOrder: ReadonlyArray<string>;
  readonly now: number;
}): ArrangeableFolder[] {
  const folders = input.folders.filter((folder) => !folder.isScratch);
  const threadsByMember = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of input.threads) {
    if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent") continue;
    const memberKey = `${thread.environmentId}:${thread.projectId}`;
    const list = threadsByMember.get(memberKey);
    if (list) list.push(thread);
    else threadsByMember.set(memberKey, [thread]);
  }
  return sortWorkspaceProjects(folders, input.projectOrder, (folder) => ({
    projectKey: folder.projectKey,
    createdAt: folder.projectCreatedAt,
  })).map((folder) => ({
    projectKey: folder.projectKey,
    title: folder.title,
    project: folder.project,
    quiet: isFolderQuiet({
      threads: folder.memberKeys.flatMap((memberKey) => threadsByMember.get(memberKey) ?? []),
      projectCreatedAt: folder.projectCreatedAt,
      quietAfterDays: input.quietAfterDays,
      foldMode: input.foldModeOf(folder.projectKey),
      now: input.now,
    }),
  }));
}

interface FolderModel {
  readonly input: WorkspaceFolderInput;
  readonly folderKey: string;
  readonly quiet: boolean;
  readonly active: EnvironmentThreadShell[];
  readonly settled: EnvironmentThreadShell[];
  readonly all: EnvironmentThreadShell[];
}

/**
 * Builds Home's rows for one workspace. `toggles` holds keys flipped from their default: folders
 * open (quiet ones closed); Quiet, Snoozed, settled threads and "show more" closed. `toRow` makes
 * the shared v2 row item, so menus and swipes behave as upstream's.
 */
export function buildWorkspaceHomeItems(input: {
  readonly workspaceId: string;
  readonly folders: ReadonlyArray<WorkspaceFolderInput>;
  /** Other workspaces' folders: their pinned threads show here too. */
  readonly otherFolders?: ReadonlyArray<WorkspaceFolderInput>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly quietAfterDays: number;
  readonly foldModeOf: (projectKey: string) => ProjectFoldMode;
  readonly toggles: ReadonlySet<string>;
  readonly projectOrder: ReadonlyArray<string>;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys: ReadonlySet<string>;
  readonly selectedThreadKey: string | null;
  /** `environmentId:threadId` of this device's voice conversation: shown first, only there. */
  readonly voiceThreadKey?: string | null;
  readonly now: number;
  readonly toRow: (item: ThreadListV2Item) => ThreadListV2ThreadListItem;
}): WorkspaceHomeListItem[] {
  const nowIso = new Date(input.now).toISOString();
  const voiceThread =
    input.voiceThreadKey == null
      ? undefined
      : input.threads.find(
          (thread) => thread.archivedAt === null && threadKey(thread) === input.voiceThreadKey,
        );
  const otherFolders = input.otherFolders ?? [];
  const folderByMember = new Map<string, WorkspaceFolderInput>();
  for (const folder of [...input.folders, ...otherFolders]) {
    for (const memberKey of folder.memberKeys) folderByMember.set(memberKey, folder);
  }
  // Subagents are left out of the folders below; they hang under the thread
  // that started them (pushAgents).
  const agents = groupThreadAgents(input.threads);
  let selectedRootKey: string | null = null;
  for (const [rootKey, list] of agents.agentsByRoot) {
    if (list.some((agent) => threadKey(agent) === input.selectedThreadKey))
      selectedRootKey = rootKey;
  }
  const threadsByFolder = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of input.threads) {
    if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent") continue;
    const folder = folderByMember.get(`${thread.environmentId}:${thread.projectId}`);
    if (!folder) continue;
    const list = threadsByFolder.get(folder.projectKey);
    if (list) list.push(thread);
    else threadsByFolder.set(folder.projectKey, [thread]);
  }

  const pinned: EnvironmentThreadShell[] = [];
  const snoozed: EnvironmentThreadShell[] = [];
  const titleByThread = new Map<string, string>();
  const models: FolderModel[] = [];
  const shelfOf = (thread: EnvironmentThreadShell) =>
    input.snoozeEnvironmentIds.has(thread.environmentId) &&
    effectiveSnoozed(thread, { now: nowIso })
      ? "snoozed"
      : input.settlementEnvironmentIds.has(thread.environmentId) &&
          thread.settledOverride === "settled" &&
          !input.queuedThreadKeys.has(threadKey(thread))
        ? "settled"
        : thread.pinnedAt != null
          ? "pinned"
          : "active";
  for (const folder of otherFolders) {
    for (const thread of threadsByFolder.get(folder.projectKey) ?? []) {
      if (thread === voiceThread || shelfOf(thread) !== "pinned") continue;
      titleByThread.set(threadKey(thread), folder.title);
      pinned.push(thread);
    }
  }
  for (const folder of input.folders) {
    const all = threadsByFolder.get(folder.projectKey) ?? [];
    const active: EnvironmentThreadShell[] = [];
    const settled: EnvironmentThreadShell[] = [];
    for (const thread of all) {
      titleByThread.set(threadKey(thread), folder.title);
      if (thread === voiceThread) continue;
      const shelf = shelfOf(thread);
      if (shelf === "snoozed") snoozed.push(thread);
      else if (shelf === "settled") settled.push(thread);
      else if (shelf === "pinned") pinned.push(thread);
      else active.push(thread);
    }
    models.push({
      input: folder,
      folderKey: `${input.workspaceId}:${folder.projectKey}`,
      quiet:
        !folder.isScratch &&
        isFolderQuiet({
          threads: all,
          projectCreatedAt: folder.projectCreatedAt,
          quietAfterDays: input.quietAfterDays,
          foldMode: input.foldModeOf(folder.projectKey),
          now: input.now,
        }),
      active: sortActiveThreadsByOrderKey(active),
      settled: settled.sort(
        (left, right) =>
          (toSortableTimestamp(right.settledAt ?? undefined) ?? 0) -
          (toSortableTimestamp(left.settledAt ?? undefined) ?? 0),
      ),
      all,
    });
  }
  const ordered = sortWorkspaceProjects(
    models.filter((model) => !model.input.isScratch),
    input.projectOrder,
    (model) => ({ projectKey: model.input.projectKey, createdAt: model.input.projectCreatedAt }),
  );

  const rows: WorkspaceHomeListItem[] = [];
  const pushThread = (
    thread: EnvironmentThreadShell,
    flags: {
      variant: "card" | "slim";
      snoozed?: boolean;
      pinned?: boolean;
      nested?: boolean;
      voice?: boolean;
    },
    projectLabel: string | null,
  ) => {
    const { type: _type, ...row } = input.toRow({
      thread,
      variant: flags.variant,
      snoozed: flags.snoozed === true,
      pinned: flags.pinned === true,
      wokeAt: resolveThreadListV2WokeAt(thread, { now: nowIso }),
      isLast: false,
    });
    rows.push({
      ...row,
      type: "ws-thread",
      key: `ws-thread:${threadKey(thread)}`,
      timeLabel: row.snoozeWakeLabelText ?? compactAgo(threadActivityMs(thread), input.now),
      projectLabel,
      ...(flags.nested ? { nested: true } : {}),
      ...(flags.voice ? { voice: true } : {}),
    });
    if (!flags.nested) pushAgents(thread);
  };
  const has = (key: string) => input.toggles.has(key);
  const pushAgents = (thread: EnvironmentThreadShell) => {
    const rootKey = threadKey(thread);
    const list = agents.agentsByRoot.get(rootKey);
    if (!list) return;
    const summary = summarizeThreadAgents(list);
    const holdsRoute = selectedRootKey === rootKey;
    const toggleKey = threadAgentsChoiceKey(rootKey, summary);
    // A stored toggle flips the line from what it does by default.
    const byDefault = threadAgentsDisplay(summary, { holdsRoute, choice: undefined });
    const display = threadAgentsDisplay(summary, {
      holdsRoute,
      choice: has(toggleKey) ? byDefault !== "open" : undefined,
    });
    if (display === "hidden") return;
    const open = display === "open";
    rows.push({
      type: "ws-agents",
      key: `ws-agents:${rootKey}`,
      toggleKey,
      open,
      label: threadAgentsLabel(summary),
      dots: list.map((agent, index) => ({
        key: threadKey(agent),
        state: summary.states[index] ?? "done",
      })),
    });
    if (!open) return;
    for (const agent of list) {
      if (agent !== voiceThread) pushThread(agent, { variant: "card", nested: true }, null);
    }
  };

  if (voiceThread) {
    pushThread(
      voiceThread,
      { variant: "card", voice: true },
      folderByMember.get(`${voiceThread.environmentId}:${voiceThread.projectId}`)?.title ?? null,
    );
  }
  if (pinned.length > 0) {
    rows.push({
      type: "ws-section",
      key: "ws-section:pinned",
      kind: "pinned",
      count: pinned.length,
      toggleKey: null,
      open: true,
    });
    for (const thread of sortPinnedThreadsByOrderKey(pinned)) {
      pushThread(thread, { variant: "card", pinned: true }, titleByThread.get(threadKey(thread))!);
    }
  }

  const pushFolder = (model: FolderModel) => {
    const { folderKey } = model;
    const open = !model.quiet !== has(folderKey);
    const holdsSelected = (thread: EnvironmentThreadShell) =>
      threadKey(thread) === input.selectedThreadKey || threadKey(thread) === selectedRootKey;
    rows.push({
      type: "ws-folder",
      key: `ws-folder:${folderKey}`,
      folderKey,
      projectKey: model.input.projectKey,
      title: model.input.title,
      project: model.input.project,
      open,
      quiet: model.quiet,
      foldMode: input.foldModeOf(model.input.projectKey),
      isScratch: model.input.isScratch,
      workspaceIds: model.input.workspaceIds ?? [],
      attention: model.all.filter(needsAttention).length,
      working: model.all.filter((thread) => resolveThreadListV2Status(thread) === "working").length,
    });
    if (!open) {
      const selected = model.active.find(holdsSelected);
      if (selected) pushThread(selected, { variant: "card" }, null);
      return;
    }
    const moreKey = `more:${folderKey}`;
    const expanded = has(moreKey);
    let visible = model.active;
    if (!expanded && visible.length > FOLDER_PREVIEW_COUNT) {
      visible = visible.slice(0, FOLDER_PREVIEW_COUNT);
      const selected = model.active.find(holdsSelected);
      if (selected && !visible.includes(selected)) visible = [...visible, selected];
    }
    for (const thread of visible) pushThread(thread, { variant: "card" }, null);
    if (model.active.length > FOLDER_PREVIEW_COUNT) {
      rows.push({
        type: "ws-more",
        key: `ws-more:${moreKey}`,
        toggleKey: moreKey,
        label: expanded ? "Show less" : `Show ${model.active.length - visible.length} more`,
      });
    }
    if (model.active.length === 0 && model.settled.length === 0) {
      rows.push({
        type: "ws-more",
        key: `ws-more:new:${folderKey}`,
        toggleKey: `new:${folderKey}`,
        label: "New thread",
        newThreadIn: model.input.project,
      });
    }
    if (model.settled.length > 0) {
      const settledKey = `settled:${folderKey}`;
      const settledOpen = has(settledKey);
      if (settledOpen) {
        for (const thread of model.settled) pushThread(thread, { variant: "slim" }, null);
      }
      rows.push({
        type: "ws-more",
        key: `ws-more:${settledKey}`,
        toggleKey: settledKey,
        label: settledOpen ? "Hide settled" : `${model.settled.length} settled`,
      });
    }
  };

  const loud = ordered.filter((model) => !model.quiet);
  const quiet = ordered.filter((model) => model.quiet);
  for (const model of loud) pushFolder(model);
  if (quiet.length > 0) {
    const quietKey = `quiet:${input.workspaceId}`;
    const holdsSelected = quiet.some((model) =>
      model.all.some((thread) => threadKey(thread) === input.selectedThreadKey),
    );
    const open = has(quietKey) || holdsSelected;
    rows.push({
      type: "ws-section",
      key: `ws-section:${quietKey}`,
      kind: "quiet",
      count: quiet.length,
      toggleKey: quietKey,
      open,
    });
    if (open) for (const model of quiet) pushFolder(model);
  }
  for (const model of models) if (model.input.isScratch) pushFolder(model);
  if (snoozed.length > 0) {
    const snoozedKey = `snoozed:${input.workspaceId}`;
    const open = has(snoozedKey);
    rows.push({
      type: "ws-section",
      key: `ws-section:${snoozedKey}`,
      kind: "snoozed",
      count: snoozed.length,
      toggleKey: snoozedKey,
      open,
    });
    if (open) {
      const ordered = snoozed.sort(
        (left, right) =>
          (toSortableTimestamp(left.snoozedUntil ?? undefined) ?? 0) -
          (toSortableTimestamp(right.snoozedUntil ?? undefined) ?? 0),
      );
      for (const thread of ordered) {
        pushThread(
          thread,
          { variant: "card", snoozed: true },
          titleByThread.get(threadKey(thread))!,
        );
      }
    }
  }
  return rows;
}

/** Recycled-list equality: fork rows compare by what they draw. */
export function workspaceHomeItemsAreEqual(
  previous: WorkspaceHomeListItem,
  item: WorkspaceHomeListItem,
): boolean {
  if (previous.key !== item.key) return false;
  switch (item.type) {
    case "ws-section":
      return (
        previous.type === "ws-section" &&
        previous.count === item.count &&
        previous.open === item.open
      );
    case "ws-folder":
      return (
        previous.type === "ws-folder" &&
        previous.title === item.title &&
        previous.project === item.project &&
        previous.open === item.open &&
        previous.quiet === item.quiet &&
        previous.foldMode === item.foldMode &&
        previous.workspaceIds.join("\n") === item.workspaceIds.join("\n") &&
        previous.attention === item.attention &&
        previous.working === item.working
      );
    case "ws-more":
      return previous.type === "ws-more" && previous.label === item.label;
    case "ws-agents":
      return (
        previous.type === "ws-agents" &&
        previous.open === item.open &&
        previous.label === item.label &&
        previous.dots.length === item.dots.length &&
        previous.dots.every(
          (dot, index) =>
            dot.key === item.dots[index]?.key && dot.state === item.dots[index]?.state,
        )
      );
    case "ws-thread":
      return (
        previous.type === "ws-thread" &&
        previous.projectLabel === item.projectLabel &&
        previous.nested === item.nested &&
        previous.voice === item.voice &&
        threadListV2ListItemsAreEqual(
          { ...previous, type: "v2-thread" },
          { ...item, type: "v2-thread" },
        )
      );
    default:
      return (
        previous.type !== "ws-section" &&
        previous.type !== "ws-folder" &&
        previous.type !== "ws-more" &&
        previous.type !== "ws-thread" &&
        previous.type !== "ws-agents" &&
        threadListV2ListItemsAreEqual(previous, item)
      );
  }
}
