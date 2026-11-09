import type { EnvironmentId, RunId, ServerProvider, ThreadId } from "@t3tools/contracts";

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

/**
 * The machine a fork dialog starts on: the first other machine whose catalog can
 * run a model, then any connected other machine so its card can explain why,
 * then the source itself.
 */
export function defaultForkTarget(input: {
  readonly sourceEnvironmentId: string;
  readonly candidates: ReadonlyArray<{
    readonly environmentId: string;
    readonly connected: boolean;
    /** The shared draft resolver's answer for the target machine, not a raw catalog count. */
    readonly hasUsableModel: boolean | null;
  }>;
}): string {
  const others = input.candidates.filter(
    (candidate) => candidate.environmentId !== input.sourceEnvironmentId,
  );
  return (
    others.find((candidate) => candidate.connected && candidate.hasUsableModel === true)
      ?.environmentId ??
    others.find((candidate) => candidate.connected)?.environmentId ??
    others[0]?.environmentId ??
    input.sourceEnvironmentId
  );
}

/** A thread reference without pulling the app-specific scoped-ref helper into this module. */
export interface ThreadForkTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** An app adapter's normalized fork-command result, including interruption. */
export type ThreadForkCommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly interrupted: boolean; readonly message: string };

export type ThreadForkOutcome =
  | { readonly kind: "forked"; readonly target: ThreadForkTarget }
  | { readonly kind: "source-missing" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "created-unavailable"; readonly target: ThreadForkTarget };

export interface ThreadForkDeps {
  readonly readThread: (target: ThreadForkTarget) => EnvironmentThreadShell | null;
  readonly threadsInEnvironment: (
    environmentId: EnvironmentId,
  ) => readonly EnvironmentThreadShell[];
  readonly createThreadId: () => ThreadId;
  readonly fork: (input: {
    readonly sourceThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
    readonly runId?: RunId;
    readonly title: string;
  }) => Promise<ThreadForkCommandResult>;
  readonly waitForThread: (target: ThreadForkTarget) => Promise<boolean>;
  readonly reorder: (target: ThreadForkTarget, orderKey: string) => Promise<unknown>;
  readonly now: () => string;
}

/**
 * The shared sidebar fork sequence: name the fork "Title (n)", create it from the requested
 * run, wait for its shell, place it under the source, and report which UI step the app owes.
 */
export async function runThreadFork(
  source: ThreadForkTarget,
  runId: RunId | undefined,
  deps: ThreadForkDeps,
): Promise<ThreadForkOutcome> {
  const sourceThread = deps.readThread(source);
  if (!sourceThread) return { kind: "source-missing" };
  const environmentThreads = () => deps.threadsInEnvironment(source.environmentId);
  const target: ThreadForkTarget = {
    environmentId: source.environmentId,
    threadId: deps.createThreadId(),
  };
  const result = await deps.fork({
    sourceThreadId: source.threadId,
    targetThreadId: target.threadId,
    ...(runId === undefined ? {} : { runId }),
    title: nextForkTitle(
      sourceThread.title,
      environmentThreads().map((thread) => thread.title),
    ),
  });
  if (!result.ok) {
    return result.interrupted
      ? { kind: "interrupted" }
      : { kind: "failed", message: result.message };
  }
  if (!(await deps.waitForThread(target))) return { kind: "created-unavailable", target };
  const placement = planForkPlacement({
    threads: environmentThreads().filter((thread) => thread.projectId === sourceThread.projectId),
    sourceId: source.threadId,
    forkId: target.threadId,
    now: deps.now(),
  });
  // Placement is cosmetic: a failed write leaves the fork on top.
  await Promise.all(
    placement.map((write) =>
      deps.reorder(
        {
          environmentId: source.environmentId,
          threadId: write.id as ThreadId,
        },
        write.orderKey,
      ),
    ),
  );
  return { kind: "forked", target };
}
