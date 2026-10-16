import {
  type EnvironmentId,
  type InboxEntry,
  type InboxSeverity,
  type InboxSnapshot,
} from "@t3tools/contracts";
import {
  inboxIssueKey,
  sortInboxIssues,
  type ScopedInboxIssue,
} from "@t3tools/client-runtime/inbox";

/** Closed issues per page of the Closed tab, and the subscription's default. */
export const INBOX_CLOSED_PAGE_SIZE = 30;

/** One environment's inbox subscription as the aggregate sees it. */
export interface InboxSource {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  /** Null until the first snapshot, or when the environment has no inbox. */
  readonly snapshot: InboxSnapshot | null;
  /** Still waiting for a first snapshot from a connected environment. */
  readonly pending: boolean;
}

export interface InboxListState {
  /** Every issue the phone knows about, `sortInboxIssues` order. */
  readonly items: ReadonlyArray<ScopedInboxIssue>;
  readonly open: ReadonlyArray<ScopedInboxIssue>;
  /** Newest closed first, at most `closedLimit` across all environments. */
  readonly closed: ReadonlyArray<ScopedInboxIssue>;
  /** Closed issues on every environment, including ones not loaded yet. */
  readonly closedTotal: number;
  /** Nothing has arrived yet but a connected environment is still loading. */
  readonly isLoading: boolean;
}

/**
 * Merges every environment's snapshot into one list. Each environment sends
 * its newest `closedLimit` closed issues, so the global newest `closedLimit`
 * are always among them; trimming after the merge keeps the page boundary
 * honest across machines.
 */
export function mergeInboxSources(
  sources: ReadonlyArray<InboxSource>,
  closedLimit: number,
): InboxListState {
  const scoped: ScopedInboxIssue[] = [];
  let closedTotal = 0;
  for (const source of sources) {
    if (source.snapshot === null) continue;
    closedTotal += source.snapshot.closedTotal;
    for (const issue of source.snapshot.issues) {
      scoped.push({
        environmentId: source.environmentId,
        environmentLabel: source.environmentLabel,
        issue,
      });
    }
  }
  const sorted = sortInboxIssues(scoped);
  const open = sorted.filter((item) => item.issue.state === "open");
  const closed = sorted.filter((item) => item.issue.state !== "open").slice(0, closedLimit);
  return {
    items: [...open, ...closed],
    open,
    closed,
    closedTotal,
    isLoading: scoped.length === 0 && sources.some((source) => source.pending),
  };
}

export const INBOX_SEVERITY_LABELS: Record<InboxSeverity, string> = {
  action: "Needs action",
  attention: "Needs attention",
  info: "For the record",
};

/** Severity is a small dot, the thread list's status idiom; the words stay neutral. */
export const INBOX_SEVERITY_DOT: Record<InboxSeverity, string> = {
  action: "bg-adaptive-rose-500-400",
  attention: "bg-adaptive-amber-700-400",
  info: "bg-adaptive-neutral-400-500",
};

export type InboxListRow =
  | {
      readonly kind: "section";
      readonly key: string;
      readonly severity: InboxSeverity;
      readonly count: number;
    }
  | { readonly kind: "issue"; readonly key: string; readonly item: ScopedInboxIssue };

/** Open issues under a header per severity; `items` must already be sorted. */
export function buildOpenInboxRows(items: ReadonlyArray<ScopedInboxIssue>): InboxListRow[] {
  const counts = new Map<InboxSeverity, number>();
  for (const { issue } of items) counts.set(issue.severity, (counts.get(issue.severity) ?? 0) + 1);
  const rows: InboxListRow[] = [];
  let severity: InboxSeverity | null = null;
  for (const item of items) {
    if (item.issue.severity !== severity) {
      severity = item.issue.severity;
      rows.push({
        kind: "section",
        key: `section:${severity}`,
        severity,
        count: counts.get(severity) ?? 0,
      });
    }
    rows.push({ kind: "issue", key: inboxIssueKey(item), item });
  }
  return rows;
}

export function buildClosedInboxRows(items: ReadonlyArray<ScopedInboxIssue>): InboxListRow[] {
  return items.map((item) => ({ kind: "issue", key: inboxIssueKey(item), item }));
}

/** muted: bookkeeping; default: worth reading; outcome: how the issue ended, with its note. */
export type InboxEventTone = "default" | "muted" | "outcome";

export type InboxEntryPresentation =
  | { readonly kind: "comment"; readonly side: "owner" | "agent"; readonly text: string }
  | {
      readonly kind: "event";
      readonly label: string;
      /** Extra text shown under the label, such as a resolution. */
      readonly detail: string | null;
      readonly tone: InboxEventTone;
    };

/** How one history entry reads in the Issue screen's feed; the web inbox reads the same. */
export function presentInboxEntry(entry: InboxEntry): InboxEntryPresentation {
  const text = entry.text?.trim() ? entry.text.trim() : null;
  const event = (label: string, detail: string | null, tone: InboxEventTone) => ({
    kind: "event" as const,
    label,
    detail,
    tone,
  });
  switch (entry.kind) {
    case "comment":
      return {
        kind: "comment",
        side: entry.author === "owner" ? "owner" : "agent",
        text: text ?? "",
      };
    case "created":
      return event("Issue raised", null, "muted");
    case "updated":
      return event(text ? `Updated: ${text}` : "Updated", null, "muted");
    case "waiting":
      return event("Waiting for your answer", text, "default");
    case "waiting_cleared":
      return event("No longer waiting", null, "muted");
    case "reminder":
      return event("Reminder: still waiting for your answer", null, "default");
    case "handover":
      return event(text ? `Handed over: ${text}` : "Handed over", null, "muted");
    case "reopened":
      return event("The problem came back", text, "default");
    case "repeated":
      return event("Reported again", null, "muted");
    case "resolved":
      return event("Resolved", text, "outcome");
    case "dismissed":
      return event("Closed as not relevant", text, "outcome");
    case "undismissed":
      return event("Reopened", null, "default");
  }
}

/** Warnings for owner comments or notices that did not reach an agent. */
export function failedInboxDeliveries(entry: InboxEntry): string[] {
  return entry.deliveries
    .filter((delivery) => delivery.status === "failed")
    .map((delivery) => `Not delivered to the agent: ${delivery.error ?? "unknown error"}`);
}
