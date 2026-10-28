import type { ThreadRuntimeSummary } from "./models.ts";

// Thread agents (sidebar fork): subagents a thread launched hang under it in
// the thread list, behind one summary line, instead of standing beside it as
// ordinary threads — shared by web and mobile.

export interface AgentThreadInput {
  readonly id: string;
  readonly environmentId: string;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly lineage: {
    readonly relationshipToParent: string | null;
    readonly parentThreadId?: string | null;
  };
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly runtime: Pick<ThreadRuntimeSummary, "status"> | null;
  /**
   * The server shell. A subagent has no runs of its own, so runtime stays null;
   * the server reports its root node status here instead.
   */
  readonly source?: { readonly status: string };
}

export type AgentRunState = "working" | "attention" | "failed" | "done";

const WORKING_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export function agentRunState(thread: AgentThreadInput): AgentRunState {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "attention";
  const status = thread.runtime?.status ?? thread.source?.status;
  if (status !== undefined && WORKING_STATUSES.has(status)) return "working";
  if (status === "failed") return "failed";
  return "done";
}

const keyOf = (environmentId: string, threadId: string) => `${environmentId}:${threadId}`;

/**
 * Every unarchived subagent, nested ones included, under the top-level thread that started it, by
 * `environmentId:threadId`, in launch order. Subagents whose top-level thread is not in `threads`
 * stay out, so they still show as ordinary rows.
 */
export function groupThreadAgents<T extends AgentThreadInput>(
  threads: ReadonlyArray<T>,
): { readonly agentsByRoot: ReadonlyMap<string, T[]>; readonly nested: ReadonlySet<string> } {
  const byKey = new Map(threads.map((thread) => [keyOf(thread.environmentId, thread.id), thread]));
  const agentsByRoot = new Map<string, T[]>();
  const nested = new Set<string>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.lineage.relationshipToParent !== "subagent") continue;
    let current: T | undefined = thread;
    const seen = new Set<string>();
    while (current && current.lineage.relationshipToParent === "subagent") {
      const parentId = current.lineage.parentThreadId;
      if (!parentId || seen.has(parentId)) {
        current = undefined;
        break;
      }
      seen.add(parentId);
      current = byKey.get(keyOf(thread.environmentId, parentId));
    }
    if (!current || current.archivedAt !== null) continue;
    const rootKey = keyOf(current.environmentId, current.id);
    const list = agentsByRoot.get(rootKey);
    if (list) list.push(thread);
    else agentsByRoot.set(rootKey, [thread]);
    nested.add(keyOf(thread.environmentId, thread.id));
  }
  for (const list of agentsByRoot.values()) {
    list.sort(
      (left, right) => (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0),
    );
  }
  return { agentsByRoot, nested };
}

export interface ThreadAgentsSummary {
  readonly total: number;
  readonly working: number;
  readonly attention: number;
  readonly failed: number;
  readonly states: ReadonlyArray<AgentRunState>;
}

export function summarizeThreadAgents(
  agents: ReadonlyArray<AgentThreadInput>,
): ThreadAgentsSummary {
  const states = agents.map(agentRunState);
  const count = (state: AgentRunState) => states.filter((entry) => entry === state).length;
  return {
    total: agents.length,
    working: count("working"),
    attention: count("attention"),
    failed: count("failed"),
    states,
  };
}

export type ThreadAgentsDisplay = "hidden" | "folded" | "open";

/** Some agent still works or needs the user. */
export function threadAgentsLive(summary: ThreadAgentsSummary): boolean {
  return summary.working > 0 || summary.attention > 0;
}

/**
 * How the agents line shows under a thread: open while any agent works, needs the user, or is
 * being read; gone once all are done, except failed agents leave it folded. A `choice` then shows
 * (`true`) or hides (`false`) it.
 */
export function threadAgentsDisplay(
  summary: ThreadAgentsSummary,
  input: { readonly holdsRoute: boolean; readonly choice: boolean | undefined },
): ThreadAgentsDisplay {
  if (threadAgentsLive(summary) || input.holdsRoute)
    return input.choice === false ? "folded" : "open";
  if (input.choice !== undefined) return input.choice ? "open" : "hidden";
  return summary.failed > 0 ? "folded" : "hidden";
}

/**
 * Where the user's choice for a thread's agents line is kept. It names the
 * state and the agent count, so the choice lapses once the agents finish or
 * the thread launches more: finished agents fold away again.
 */
export function threadAgentsChoiceKey(rootKey: string, summary: ThreadAgentsSummary): string {
  return `agents:${rootKey}:${threadAgentsLive(summary) ? "live" : "done"}:${summary.total}`;
}

/** "5 agents · 4 working", "5 agents · 1 needs you", "5 agents · done". */
export function threadAgentsLabel(summary: ThreadAgentsSummary): string {
  const parts = [`${summary.total} ${summary.total === 1 ? "agent" : "agents"}`];
  if (summary.attention > 0) parts.push(`${summary.attention} needs you`);
  if (summary.working > 0) parts.push(`${summary.working} working`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (parts.length === 1) parts.push("done");
  return parts.join(" · ");
}
