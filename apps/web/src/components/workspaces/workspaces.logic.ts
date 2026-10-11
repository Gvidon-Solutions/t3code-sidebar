import type { SidebarWorkspace, SidebarWorkspacesConfig } from "@t3tools/contracts";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";

import type { SidebarThreadSummary } from "../../types";
import {
  hasUnseenCompletion,
  isSidebarThreadWorking,
  resolveSidebarThreadStatus,
} from "../Sidebar.logic";

export const WORKSPACE_COLORS = [
  "#6d8cff",
  "#e0795b",
  "#4fb58f",
  "#c27bd6",
  "#d9a640",
  "#4fa9c9",
  "#de6b8f",
  "#8f9a5a",
] as const;

/** `icon` values with this prefix name a built-in glyph; anything else is a short label. */
export const WORKSPACE_GLYPH_PREFIX = "glyph:";
/** Longest tile label, in user-perceived characters (an emoji counts as one). */
export const WORKSPACE_LABEL_MAX = 2;

const graphemes = (value: string): string[] =>
  Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
    (part) => part.segment,
  );

/** Trims a typed tile label to its first few characters; null when nothing is left. */
export function normalizeWorkspaceLabel(raw: string): string | null {
  const label = graphemes(raw.trim()).slice(0, WORKSPACE_LABEL_MAX).join("").trim();
  return label.length > 0 ? label : null;
}

export type WorkspaceMarkSpec = { kind: "glyph"; glyph: string } | { kind: "text"; text: string };

/** What a tile shows: a built-in glyph, the custom label, or the name's first letter. */
export function workspaceMark(
  workspace: Pick<SidebarWorkspace, "name" | "icon">,
): WorkspaceMarkSpec {
  const icon = workspace.icon?.trim();
  if (icon?.startsWith(WORKSPACE_GLYPH_PREFIX)) {
    return { kind: "glyph", glyph: icon.slice(WORKSPACE_GLYPH_PREFIX.length) };
  }
  const label = icon ? normalizeWorkspaceLabel(icon) : null;
  if (label) return { kind: "text", text: label };
  const letter = graphemes(workspace.name.trim())[0];
  return { kind: "text", text: letter ? letter.toUpperCase() : "?" };
}

export function workspaceColor(workspace: Pick<SidebarWorkspace, "id" | "color">): string {
  if (workspace.color) return workspace.color;
  let hash = 0;
  for (const char of workspace.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return WORKSPACE_COLORS[hash % WORKSPACE_COLORS.length]!;
}

const globCache = new Map<string, RegExp>();

/** `*` matches within one path segment, `**` across segments. Case-sensitive. */
export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const regExp = new RegExp(`^${source}$`);
  globCache.set(glob, regExp);
  return regExp;
}

export interface WorkspaceProjectIdentity {
  readonly projectKey: string;
  /** Workspace roots of every member project (one per environment). */
  readonly workspaceRoots: readonly string[];
}

/**
 * The workspace a project belongs to: explicit assignment, then the first
 * matching rule, then the default (or first) workspace. Null only when there
 * are no workspaces at all.
 */
export function resolveProjectWorkspaceId(
  project: WorkspaceProjectIdentity,
  config: SidebarWorkspacesConfig,
): string | null {
  const known = new Set(config.workspaces.map((workspace) => workspace.id));
  const assigned = config.assignments[project.projectKey];
  if (assigned !== undefined && known.has(assigned)) return assigned;
  for (const rule of config.rules) {
    if (!known.has(rule.workspace)) continue;
    const pattern = globToRegExp(rule.match);
    if (project.workspaceRoots.some((root) => pattern.test(root))) return rule.workspace;
  }
  return effectiveDefaultWorkspaceId(config);
}

/**
 * The workspace unplaced projects fall into: the configured default, or the
 * first workspace when that is unset or gone. It is the one workspace that
 * can't be deleted, so there is always somewhere for projects to land.
 */
export function effectiveDefaultWorkspaceId(config: SidebarWorkspacesConfig): string | null {
  const configured = config.defaultWorkspace;
  if (configured !== null && config.workspaces.some((workspace) => workspace.id === configured)) {
    return configured;
  }
  return config.workspaces[0]?.id ?? null;
}

/**
 * Moves a workspace so it sits before `beforeIndex` (a slot in the current
 * order, 0..length) and returns the new order; unknown ids leave it as is.
 */
export function reorderWorkspaces<T extends { readonly id: string }>(
  workspaces: readonly T[],
  workspaceId: string,
  beforeIndex: number,
): readonly T[] {
  const from = workspaces.findIndex((workspace) => workspace.id === workspaceId);
  if (from < 0) return workspaces;
  const moved = workspaces[from]!;
  const insertAt = Math.max(
    0,
    Math.min(beforeIndex > from ? beforeIndex - 1 : beforeIndex, workspaces.length - 1),
  );
  if (insertAt === from) return workspaces;
  const next = workspaces.filter((_, index) => index !== from);
  next.splice(insertAt, 0, moved);
  return next;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function timestampMs(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

/** Last moment the thread saw activity, for quiet detection and time labels. */
export function threadActivityMs(thread: SidebarThreadSummary): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const value of [
    thread.latestTurn?.completedAt,
    thread.latestTurn?.startedAt,
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
  return status === "approval" || status === "input" || status === "failed";
}

/**
 * A project is quiet when nothing in it asks for a look: no pinned, working
 * or blocked thread, and no active thread touched within `quietAfterDays`.
 * Settled and snoozed threads never keep a project loud.
 */
export function isProjectQuiet(input: {
  readonly threads: readonly SidebarThreadSummary[];
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
    if (needsAttention(thread) || isSidebarThreadWorking(thread)) return false;
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
 * Done-but-unread: the latest turn finished after this device last looked.
 * A thread this device never opened counts from `seenBaselineAt` instead.
 */
export function isThreadUnread(
  thread: SidebarThreadSummary,
  lastVisitedAt: string | undefined,
  seenBaselineAt: string | null,
): boolean {
  return hasUnseenCompletion({
    ...thread,
    lastVisitedAt: lastVisitedAt ?? seenBaselineAt ?? undefined,
  });
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
    if (status === "failed") failed += 1;
    if (status === "approval" || status === "input" || status === "failed") attention += 1;
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

/** Lowercase slug for a new workspace id, unique against `taken`. */
export function makeWorkspaceId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9а-яё]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "workspace";
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${base}-${suffix}`;
  return candidate;
}
