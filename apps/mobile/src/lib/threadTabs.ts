/**
 * Thread tabs (sidebar fork): files a thread has open next to its chat, each
 * with the mode and scroll position it was left at. Kept per thread in the
 * device preferences.
 */

export type ThreadTabMode = "preview" | "source";

export interface ThreadTab {
  readonly path: string;
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
): ThreadTabsState {
  const tabs = state?.tabs ?? [];
  const existing = tabs.find((tab) => tab.path === path);
  if (existing) {
    return {
      tabs: tabs.map((tab) => (tab.path === path ? { ...tab, usedAt: now } : tab)),
      usedAt: now,
    };
  }
  let next = [...tabs, { path, usedAt: now }];
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
      const { path, mode, scroll, usedAt: tabUsedAt } = tab as Record<string, unknown>;
      if (typeof path !== "string" || typeof tabUsedAt !== "number") return [];
      const cleanScroll: Partial<Record<ThreadTabMode, number>> = {};
      if (typeof scroll === "object" && scroll !== null) {
        for (const [key, y] of Object.entries(scroll)) {
          if (isMode(key) && typeof y === "number" && Number.isFinite(y)) cleanScroll[key] = y;
        }
      }
      return [{ path, usedAt: tabUsedAt, ...(isMode(mode) ? { mode } : {}), scroll: cleanScroll }];
    });
    result[threadKey] = { tabs: clean.slice(0, THREAD_TABS_MAX), usedAt };
  }
  return result;
}
