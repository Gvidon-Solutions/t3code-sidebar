import type { ServerProvider } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";
import { effectiveSnoozed } from "./threadSettled.ts";
import { planPinnedReorder, sortActiveThreadsByOrderKey } from "./threadSort.ts";

// Thread forks (sidebar fork): which threads offer "Fork", what the fork is
// called, and where it lands — shared by web and mobile.

/** Forking from the thread menu is offered for these provider drivers only. */
const FORKABLE_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent"]);

export function canForkThreadFromMenu(
  thread: Pick<
    EnvironmentThreadShell,
    "providerInstanceId" | "latestRun" | "lineage" | "visibleItemCount"
  > & { readonly source: Pick<EnvironmentThreadShell["source"], "historyOrigin"> },
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">> | undefined,
): boolean {
  if (thread.lineage.relationshipToParent === "subagent") return false;
  // Imported history forks even before anyone continued the thread.
  const hasHistory =
    thread.latestRun !== null ||
    (thread.source.historyOrigin === "v1_import" && thread.visibleItemCount > 0);
  if (!hasHistory) return false;
  const driver =
    providers?.find((provider) => provider.instanceId === thread.providerInstanceId)?.driver ??
    thread.providerInstanceId;
  return FORKABLE_DRIVERS.has(driver);
}

const FORK_NUMBER = /^ \((\d{1,3})\)$/;

/**
 * "Title (n)": forks of one thread, and forks of those forks, share the
 * source's base title and count up from the highest number taken.
 */
export function nextForkTitle(sourceTitle: string, takenTitles: Iterable<string>): string {
  const suffix = /\s\(\d{1,3}\)$/.exec(sourceTitle);
  const base = suffix && suffix.index > 0 ? sourceTitle.slice(0, suffix.index) : sourceTitle;
  let highest = 0;
  for (const title of takenTitles) {
    if (!title.startsWith(base)) continue;
    const match = FORK_NUMBER.exec(title.slice(base.length));
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${base} (${highest + 1})`;
}

/**
 * Active-order writes that put a new fork right under its source (after its
 * earlier forks) in the project's active list. Empty when the source is not in that list (pinned,
 * settled, snoozed): the fork then stays on top as the newest thread.
 */
export function planForkPlacement(input: {
  /** Threads of the source's project, in any state, including the fork. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly sourceId: string;
  readonly forkId: string;
  readonly now: string;
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> {
  const active = input.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.lineage.relationshipToParent !== "subagent" &&
      thread.pinnedAt === null &&
      thread.settledOverride !== "settled" &&
      !effectiveSnoozed(thread, { now: input.now }),
  );
  const sorted = sortActiveThreadsByOrderKey(active).filter((thread) => thread.id !== input.forkId);
  let at = sorted.findIndex((thread) => thread.id === input.sourceId);
  if (at < 0 || !active.some((thread) => thread.id === input.forkId)) return [];
  // After the source's earlier forks, so they read (1), (2), (3).
  while (sorted[at + 1]?.lineage.parentThreadId === input.sourceId) at += 1;
  const ordered = sorted.map((thread) => thread.id as string);
  ordered.splice(at + 1, 0, input.forkId);
  return planPinnedReorder({
    orderedIds: ordered,
    keysById: new Map(input.threads.map((thread) => [thread.id, thread.activeOrderKey])),
    movedId: input.forkId,
  });
}
