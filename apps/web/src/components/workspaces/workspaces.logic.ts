import type { ProjectFoldMode } from "@t3tools/client-runtime/state/sidebar-workspaces";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";

import type { SidebarThreadSummary } from "../../types";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";

export {
  addWorkspace,
  deleteWorkspace,
  dropProjectOnWorkspace,
  moveProjectInWorkspace,
  projectFoldModeOf,
  projectOrderOf,
  setProjectFoldMode,
  resolveProjectWorkspaceIds,
  toggleProjectWorkspace,
  updateWorkspace,
  WORKSPACE_COLORS,
  WORKSPACE_GLYPH_PREFIX,
  WORKSPACE_LABEL_MAX,
  effectiveDefaultWorkspaceId,
  globToRegExp,
  makeWorkspaceId,
  moveProjectInOrder,
  normalizeWorkspaceLabel,
  reorderWorkspaces,
  resolveProjectWorkspaceId,
  sortWorkspaceProjects,
  workspaceColor,
  workspaceMark,
  type ProjectFoldMode,
  type WorkspaceMarkSpec,
  type WorkspaceProjectIdentity,
} from "@t3tools/client-runtime/state/sidebar-workspaces";

const DAY_MS = 24 * 60 * 60 * 1000;

function timestampMs(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

/** Last moment the thread saw activity, for quiet detection and time labels. */
export function threadActivityMs(thread: SidebarThreadSummary): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const value of [
    thread.latestRun?.completedAt,
    thread.latestRun?.startedAt,
    thread.latestUserMessageAt,
    thread.createdAt,
  ]) {
    const ms = timestampMs(value);
    if (!Number.isNaN(ms) && ms > latest) latest = ms;
  }
  return latest;
}

export function needsAttention(thread: SidebarThreadSummary): boolean {
  const status = resolveSidebarThreadStatus(thread);
  return status === "approval" || status === "input" || status === "failed" || status === "limited";
}

/**
 * A project is quiet when nothing in it asks for a look: no pinned, working
 * or blocked thread, and no active thread touched within `quietAfterDays`.
 * Settled and snoozed threads never keep a project loud. A project the user
 * moved by hand stays where they put it (`foldMode`).
 */
export function isProjectQuiet(input: {
  readonly threads: readonly SidebarThreadSummary[];
  readonly projectCreatedAt: string | null;
  readonly quietAfterDays: number;
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
    const created = timestampMs(input.projectCreatedAt);
    return Number.isNaN(created) || created < horizon;
  }
  return true;
}

export interface WorkspaceActivity {
  /** Threads blocked on the user: approval, input or failed. */
  readonly attention: number;
  readonly failed: number;
  readonly working: number;
  readonly unread: number;
}

export const EMPTY_WORKSPACE_ACTIVITY: WorkspaceActivity = {
  attention: 0,
  failed: 0,
  working: 0,
  unread: 0,
};

/**
 * Done-but-unread: the latest run finished after the last visit (the server's
 * watermark, or this device's for servers without one). A thread never visited
 * counts from `seenBaselineAt`, when this device started using the sidebar.
 */
export function isThreadUnread(
  thread: SidebarThreadSummary,
  localLastVisitedAt: string | undefined,
  seenBaselineAt: string | null,
): boolean {
  const visited = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  return hasUnseenCompletion({ ...thread, lastVisitedAt: visited ?? seenBaselineAt ?? undefined });
}

export function summarizeWorkspaceActivity(
  threads: readonly SidebarThreadSummary[],
  isUnread: (thread: SidebarThreadSummary) => boolean,
): WorkspaceActivity {
  let attention = 0;
  let failed = 0;
  let working = 0;
  let unread = 0;
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const status = resolveSidebarThreadStatus(thread);
    if (status === "failed" || status === "limited") failed += 1;
    if (needsAttention(thread)) attention += 1;
    else if (status === "working") working += 1;
    else if (isUnread(thread)) {
      unread += 1;
    }
  }
  return { attention, failed, working, unread };
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
