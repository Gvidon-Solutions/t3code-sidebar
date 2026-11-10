/**
 * Thread tabs (sidebar fork): files a thread has open next to its chat, each
 * with the mode and scroll position it was left at. Kept per thread in the
 * device preferences.
 */

export type ThreadTabMode = "preview" | "source";

/** The resolved target of a file opened through the server resolver. */
export interface ThreadTabFile {
  /** The machine that holds the file. */
  readonly environmentId: string;
  readonly absolutePath: string;
  /** The folder the file belongs to, for project-relative display and reading. */
  readonly cwd: string;
  /** The thread's own machine, for the machine tag. */
  readonly sourceEnvironmentId?: string;
  readonly projectName?: string;
  /** The path as written, when it differs from the resolved display path. */
  readonly rawPath?: string;
  readonly displayPath?: string;
  readonly notSynced?: boolean;
  readonly worktreeRemoved?: boolean;
  readonly outsideProject?: boolean;
}

export interface ThreadTab {
  readonly path: string;
  /** Set for a file the resolver opened; absent for a legacy path tab. */
  readonly file?: ThreadTabFile;
  readonly mode?: ThreadTabMode;
  /** Vertical scroll offset per mode, in points. */
  readonly scroll?: Partial<Record<ThreadTabMode, number>>;
  readonly usedAt: number;
}

export interface ThreadTabsState {
  readonly tabs: ReadonlyArray<ThreadTab>;
  readonly usedAt: number;
}

export type ThreadTabsByThread = Readonly<Record<string, ThreadTabsState>>;

export const THREAD_TABS_MAX = 8;
export const THREAD_TABS_MAX_THREADS = 40;

/** Opens (or refreshes) a tab; past the limit the least recently used one closes. */
export function openThreadTab(
  state: ThreadTabsState | undefined,
  path: string,
  now: number,
  file?: ThreadTabFile,
): ThreadTabsState {
  const tabs = state?.tabs ?? [];
  const existing = tabs.find((tab) => tab.path === path);
  if (existing) {
    return {
      tabs: tabs.map((tab) =>
        tab.path === path ? { ...tab, ...(file === undefined ? {} : { file }), usedAt: now } : tab,
      ),
      usedAt: now,
    };
  }
  let next = [...tabs, { path, ...(file === undefined ? {} : { file }), usedAt: now }];
  while (next.length > THREAD_TABS_MAX) {
    const oldest = next.reduce((a, b) => (b.usedAt < a.usedAt ? b : a));
    next = next.filter((tab) => tab !== oldest);
  }
  return { tabs: next, usedAt: now };
}

export function closeThreadTab(
  state: ThreadTabsState | undefined,
  path: string,
  now: number,
): ThreadTabsState {
  return { tabs: (state?.tabs ?? []).filter((tab) => tab.path !== path), usedAt: now };
}

export function updateThreadTab(
  state: ThreadTabsState | undefined,
  path: string,
  patch: { readonly mode?: ThreadTabMode; readonly scroll?: { mode: ThreadTabMode; y: number } },
  now: number,
): ThreadTabsState {
  const opened = openThreadTab(state, path, now);
  return {
    ...opened,
    tabs: opened.tabs.map((tab) =>
      tab.path !== path
        ? tab
        : {
            ...tab,
            ...(patch.mode ? { mode: patch.mode } : {}),
            ...(patch.scroll
              ? { scroll: { ...tab.scroll, [patch.scroll.mode]: Math.max(0, patch.scroll.y) } }
              : {}),
          },
    ),
  };
}

/** Stores one thread's tabs, dropping the threads least recently used past the cap. */
export function withThreadTabs(
  all: ThreadTabsByThread | undefined,
  threadKey: string,
  state: ThreadTabsState,
): ThreadTabsByThread {
  const entries = Object.entries({ ...all, [threadKey]: state })
    .filter(([, value]) => value.tabs.length > 0)
    .sort(([, a], [, b]) => b.usedAt - a.usedAt)
    .slice(0, THREAD_TABS_MAX_THREADS);
  return Object.fromEntries(entries);
}

const isMode = (value: unknown): value is ThreadTabMode =>
  value === "preview" || value === "source";

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const optionalBoolean = (value: unknown): boolean | undefined =>
  value === true ? true : undefined;

/** Keeps only well-formed resolver targets from a stored preferences blob. */
export function sanitizeThreadTabFile(raw: unknown): ThreadTabFile | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const environmentId = optionalString(value.environmentId);
  const absolutePath = optionalString(value.absolutePath);
  if (environmentId === undefined || absolutePath === undefined) return undefined;
  const cwd = optionalString(value.cwd) ?? "";
  const sourceEnvironmentId = optionalString(value.sourceEnvironmentId);
  const projectName = optionalString(value.projectName);
  const rawPath = optionalString(value.rawPath);
  const displayPath = optionalString(value.displayPath);
  const notSynced = optionalBoolean(value.notSynced);
  const worktreeRemoved = optionalBoolean(value.worktreeRemoved);
  const outsideProject = optionalBoolean(value.outsideProject);
  const result: ThreadTabFile = {
    environmentId,
    absolutePath,
    cwd,
    ...(sourceEnvironmentId === undefined ? {} : { sourceEnvironmentId }),
    ...(projectName === undefined ? {} : { projectName }),
    ...(rawPath === undefined ? {} : { rawPath }),
    ...(displayPath === undefined ? {} : { displayPath }),
    ...(notSynced === undefined ? {} : { notSynced }),
    ...(worktreeRemoved === undefined ? {} : { worktreeRemoved }),
    ...(outsideProject === undefined ? {} : { outsideProject }),
  };
  return result;
}

/** Keeps only well-formed tab state from a stored preferences blob. */
export function sanitizeThreadTabs(raw: unknown): ThreadTabsByThread | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const result: Record<string, ThreadTabsState> = {};
  for (const [threadKey, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const { tabs, usedAt } = value as { tabs?: unknown; usedAt?: unknown };
    if (!Array.isArray(tabs) || typeof usedAt !== "number") continue;
    const clean = tabs.flatMap((tab): ThreadTab[] => {
      if (typeof tab !== "object" || tab === null) return [];
      const { path, mode, scroll, usedAt: tabUsedAt, file } = tab as Record<string, unknown>;
      if (typeof path !== "string" || typeof tabUsedAt !== "number") return [];
      const cleanFile = sanitizeThreadTabFile(file);
      const cleanScroll: Partial<Record<ThreadTabMode, number>> = {};
      if (typeof scroll === "object" && scroll !== null) {
        for (const [key, y] of Object.entries(scroll)) {
          if (isMode(key) && typeof y === "number" && Number.isFinite(y)) cleanScroll[key] = y;
        }
      }
      return [
        {
          path,
          usedAt: tabUsedAt,
          ...(cleanFile === undefined ? {} : { file: cleanFile }),
          ...(isMode(mode) ? { mode } : {}),
          scroll: cleanScroll,
        },
      ];
    });
    result[threadKey] = { tabs: clean.slice(0, THREAD_TABS_MAX), usedAt };
  }
  return result;
}
