import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  getThreadSortTimestamp,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  toSortableTimestamp,
} from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId } from "@t3tools/contracts";

import type { HomeProjectSortOrder } from "../home/homeThreadList";
import {
  resolveThreadListV2Status,
  threadListV2ListItemsAreEqual,
  type ThreadListV2Item,
  type ThreadListV2ListItem,
  type ThreadListV2ThreadListItem,
} from "../threads/threadListV2";

/**
 * Home in workspace mode (sidebar fork), laid out like the desktop workspace
 * sidebar: pinned threads, then project folders of one-line threads, quiet
 * projects folded into one group, snoozed threads last. Same partition and
 * order rules as the desktop (`WorkspaceSidebar.tsx`).
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
}

export type WorkspaceHomeListItem =
  | ThreadListV2ListItem
  | WorkspaceSectionListItem
  | WorkspaceFolderListItem
  | WorkspaceMoreListItem
  | WorkspaceThreadListItem;

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
  readonly alwaysShow: boolean;
  readonly now: number;
}): boolean {
  if (input.alwaysShow) return false;
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

interface FolderModel {
  readonly input: WorkspaceFolderInput;
  readonly folderKey: string;
  readonly quiet: boolean;
  readonly active: EnvironmentThreadShell[];
  readonly settled: EnvironmentThreadShell[];
  readonly all: EnvironmentThreadShell[];
}

/**
 * Builds Home's rows for one workspace. `toggles` holds keys flipped from
 * their default: folders default open (quiet ones closed); the Quiet group,
 * Snoozed, a folder's settled threads and its "show more" default closed.
 * `toRow` turns a partitioned thread into the shared v2 row item (time,
 * snooze labels, queued state), so menus and swipes behave as upstream's.
 */
export function buildWorkspaceHomeItems(input: {
  readonly workspaceId: string;
  readonly folders: ReadonlyArray<WorkspaceFolderInput>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly quietAfterDays: number;
  readonly alwaysShow: ReadonlySet<string>;
  readonly toggles: ReadonlySet<string>;
  readonly sortOrder: HomeProjectSortOrder;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys: ReadonlySet<string>;
  readonly selectedThreadKey: string | null;
  readonly now: number;
  readonly toRow: (item: ThreadListV2Item) => ThreadListV2ThreadListItem;
}): WorkspaceHomeListItem[] {
  const nowIso = new Date(input.now).toISOString();
  const folderByMember = new Map<string, WorkspaceFolderInput>();
  for (const folder of input.folders) {
    for (const memberKey of folder.memberKeys) folderByMember.set(memberKey, folder);
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
  for (const folder of input.folders) {
    const all = threadsByFolder.get(folder.projectKey) ?? [];
    const active: EnvironmentThreadShell[] = [];
    const settled: EnvironmentThreadShell[] = [];
    for (const thread of all) {
      titleByThread.set(threadKey(thread), folder.title);
      if (
        input.snoozeEnvironmentIds.has(thread.environmentId) &&
        effectiveSnoozed(thread, { now: nowIso })
      ) {
        snoozed.push(thread);
      } else if (
        input.settlementEnvironmentIds.has(thread.environmentId) &&
        thread.settledOverride === "settled" &&
        !input.queuedThreadKeys.has(threadKey(thread))
      ) {
        settled.push(thread);
      } else if (thread.pinnedAt != null) {
        pinned.push(thread);
      } else {
        active.push(thread);
      }
    }
    models.push({
      input: folder,
      folderKey: `${input.workspaceId}:${folder.projectKey}`,
      quiet: isFolderQuiet({
        threads: all,
        projectCreatedAt: folder.projectCreatedAt,
        quietAfterDays: input.quietAfterDays,
        alwaysShow: input.alwaysShow.has(folder.projectKey),
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
  const folderTimestamp = (model: FolderModel) =>
    model.all.length > 0
      ? model.all.reduce(
          (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, input.sortOrder)),
          Number.NEGATIVE_INFINITY,
        )
      : (toSortableTimestamp(
          (input.sortOrder === "created_at"
            ? model.input.projectCreatedAt
            : (model.input.project.updatedAt ?? model.input.projectCreatedAt)) ?? undefined,
        ) ?? Number.NEGATIVE_INFINITY);
  const timestamps = new Map(models.map((model) => [model, folderTimestamp(model)] as const));
  models.sort(
    (left, right) =>
      (timestamps.get(right)! > timestamps.get(left)!
        ? 1
        : timestamps.get(right)! < timestamps.get(left)!
          ? -1
          : 0) || left.input.title.localeCompare(right.input.title),
  );

  const rows: WorkspaceHomeListItem[] = [];
  const pushThread = (
    thread: EnvironmentThreadShell,
    flags: { variant: "card" | "slim"; snoozed?: boolean; pinned?: boolean },
    projectLabel: string | null,
  ) => {
    const { type: _type, ...row } = input.toRow({
      thread,
      variant: flags.variant,
      snoozed: flags.snoozed === true,
      pinned: flags.pinned === true,
      isLast: false,
    });
    rows.push({
      ...row,
      type: "ws-thread",
      key: `ws-thread:${threadKey(thread)}`,
      timeLabel: row.snoozeWakeLabelText ?? compactAgo(threadActivityMs(thread), input.now),
      projectLabel,
    });
  };
  const has = (key: string) => input.toggles.has(key);

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
      threadKey(thread) === input.selectedThreadKey;
    rows.push({
      type: "ws-folder",
      key: `ws-folder:${folderKey}`,
      folderKey,
      projectKey: model.input.projectKey,
      title: model.input.title,
      project: model.input.project,
      open,
      quiet: model.quiet,
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

  const loud = models.filter((model) => !model.quiet);
  const quiet = models.filter((model) => model.quiet);
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
        previous.attention === item.attention &&
        previous.working === item.working
      );
    case "ws-more":
      return previous.type === "ws-more" && previous.label === item.label;
    case "ws-thread":
      return (
        previous.type === "ws-thread" &&
        previous.projectLabel === item.projectLabel &&
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
        threadListV2ListItemsAreEqual(previous, item)
      );
  }
}
