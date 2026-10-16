import {
  collectInboxAlerts,
  countInbox,
  type InboxAlertMarks,
  type InboxCounts,
  type ScopedInboxIssue,
  sortInboxIssues,
} from "@t3tools/client-runtime/inbox";
import type {
  EnvironmentId,
  InboxEntry,
  InboxIssue,
  InboxSeverity,
  InboxSnapshot,
} from "@t3tools/contracts";

/** Fork: agent inbox. Pure helpers behind the inbox screen, sidebar button and notifications. */

export const INBOX_CLOSED_PAGE_SIZE = 30;

export interface InboxEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly snapshot: InboxSnapshot;
}

export interface InboxEnvironmentState extends InboxEnvironmentInput {
  /** This environment's issues, in snapshot order. */
  readonly items: ReadonlyArray<ScopedInboxIssue>;
}

export interface InboxState {
  readonly environments: ReadonlyArray<InboxEnvironmentState>;
  /** Every issue, sorted: open by severity and activity, then closed. */
  readonly items: ReadonlyArray<ScopedInboxIssue>;
  readonly open: ReadonlyArray<ScopedInboxIssue>;
  readonly closed: ReadonlyArray<ScopedInboxIssue>;
  readonly counts: InboxCounts;
  /** Closed issues the servers hold, loaded or not. */
  readonly closedTotal: number;
}

export const EMPTY_INBOX_STATE: InboxState = {
  environments: [],
  items: [],
  open: [],
  closed: [],
  counts: { unread: 0, waiting: 0 },
  closedTotal: 0,
};

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a);
    const bRecord = b as Record<string, unknown>;
    return (
      aKeys.length === Object.keys(b).length &&
      aKeys.every((key) => (a as Record<string, unknown>)[key] === bRecord[key])
    );
  }
  return false;
}

/** Field-by-field equality; every snapshot decodes fresh objects for unchanged issues. */
export function sameInboxIssue(a: InboxIssue, b: InboxIssue): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as Array<keyof InboxIssue>;
  return keys.length === Object.keys(b).length && keys.every((key) => sameValue(a[key], b[key]));
}

/**
 * Builds the one inbox from each environment's latest snapshot. Unchanged
 * issues keep their previous objects, and an unchanged inbox returns
 * `previous` itself, so rows and subscribers only re-render on real change.
 */
export function mergeInboxEnvironments(
  inputs: ReadonlyArray<InboxEnvironmentInput>,
  previous: InboxState | null,
): InboxState {
  const environments = inputs.map((input): InboxEnvironmentState => {
    const prior = previous?.environments.find(
      (entry) => entry.environmentId === input.environmentId,
    );
    if (
      prior !== undefined &&
      prior.snapshot === input.snapshot &&
      prior.environmentLabel === input.environmentLabel
    ) {
      return prior;
    }
    const priorItems = new Map(prior?.items.map((item) => [item.issue.id, item]));
    const items = input.snapshot.issues.map((issue): ScopedInboxIssue => {
      const priorItem = priorItems.get(issue.id);
      return priorItem !== undefined &&
        priorItem.environmentLabel === input.environmentLabel &&
        sameInboxIssue(priorItem.issue, issue)
        ? priorItem
        : {
            environmentId: input.environmentId,
            environmentLabel: input.environmentLabel,
            issue,
          };
    });
    if (
      prior !== undefined &&
      prior.environmentLabel === input.environmentLabel &&
      prior.snapshot.closedTotal === input.snapshot.closedTotal &&
      prior.items.length === items.length &&
      prior.items.every((item, index) => item === items[index])
    ) {
      return prior;
    }
    return { ...input, items };
  });
  if (
    previous !== null &&
    previous.environments.length === environments.length &&
    previous.environments.every((entry, index) => entry === environments[index])
  ) {
    return previous;
  }
  if (environments.length === 0) return EMPTY_INBOX_STATE;
  const items = sortInboxIssues(environments.flatMap((entry) => entry.items));
  return {
    environments,
    items,
    open: items.filter((item) => item.issue.state === "open"),
    closed: items.filter((item) => item.issue.state !== "open"),
    counts: countInbox(items),
    closedTotal: environments.reduce((total, entry) => total + entry.snapshot.closedTotal, 0),
  };
}

export interface InboxSeverityGroup {
  readonly severity: InboxSeverity;
  readonly items: ReadonlyArray<ScopedInboxIssue>;
}

const SEVERITY_ORDER: ReadonlyArray<InboxSeverity> = ["action", "attention", "info"];

/** Open issues split by severity, most urgent first; empty groups are left out. */
export function groupInboxIssuesBySeverity(
  items: ReadonlyArray<ScopedInboxIssue>,
): InboxSeverityGroup[] {
  return SEVERITY_ORDER.map((severity) => ({
    severity,
    items: items.filter((item) => item.issue.severity === severity),
  })).filter((group) => group.items.length > 0);
}

export const INBOX_SEVERITY_LABEL: Record<InboxSeverity, string> = {
  action: "Needs action",
  attention: "Needs attention",
  info: "For the record",
};

/** Severity is a small dot, the sidebar's status idiom; the words stay neutral. */
export const INBOX_SEVERITY_DOT_CLASS: Record<InboxSeverity, string> = {
  action: "bg-destructive/90",
  attention: "bg-warning/90",
  info: "bg-muted-foreground/35",
};

export function inboxButtonLabel(counts: InboxCounts): string {
  const parts = ["Inbox"];
  if (counts.unread > 0) parts.push(`${counts.unread} new`);
  if (counts.waiting > 0)
    parts.push(`${counts.waiting} need${counts.waiting === 1 ? "s" : ""} your answer`);
  return parts.join(" · ");
}

/** muted: bookkeeping; default: worth reading; outcome: how the issue ended, with its note. */
export type InboxEventTone = "default" | "muted" | "outcome";

export interface InboxEventPresentation {
  readonly label: string;
  /** Extra text shown under the label, such as a resolution. */
  readonly detail: string | null;
  readonly tone: InboxEventTone;
}

/** How a non-comment history entry reads in the feed. */
export function describeInboxEvent(entry: InboxEntry): InboxEventPresentation {
  switch (entry.kind) {
    case "created":
      return { label: "Issue raised", detail: null, tone: "muted" };
    case "updated":
      return {
        label: entry.text ? `Updated: ${entry.text}` : "Updated",
        detail: null,
        tone: "muted",
      };
    case "waiting":
      return { label: "Waiting for your answer", detail: null, tone: "default" };
    case "waiting_cleared":
      return { label: "No longer waiting", detail: null, tone: "muted" };
    case "reminder":
      return { label: "Reminder: still waiting for your answer", detail: null, tone: "default" };
    case "handover":
      return {
        label: entry.text ? `Handed over: ${entry.text}` : "Handed over",
        detail: null,
        tone: "muted",
      };
    case "reopened":
      return { label: "The problem came back", detail: entry.text, tone: "default" };
    case "repeated":
      return { label: "Reported again", detail: null, tone: "muted" };
    case "resolved":
      return { label: "Resolved", detail: entry.text, tone: "outcome" };
    case "dismissed":
      return { label: "Closed as not relevant", detail: entry.text, tone: "outcome" };
    case "undismissed":
      return { label: "Reopened", detail: null, tone: "default" };
    case "comment":
      return { label: "Comment", detail: entry.text, tone: "default" };
  }
}

/** The first failed delivery's error, if an entry did not reach its agent. */
export function inboxDeliveryFailure(entry: InboxEntry): string | null {
  const failed = entry.deliveries.find((delivery) => delivery.status === "failed");
  if (failed === undefined) return null;
  return failed.error ?? "Unknown error";
}

/** Per-environment notification marks. */
export type InboxAlertMarksByEnvironment = ReadonlyMap<EnvironmentId, InboxAlertMarks>;

/**
 * Runs `collectInboxAlerts` per environment, so an environment that connects
 * later than the others only sets its marks on its first snapshot instead of
 * announcing everything it holds. Marks of issues no longer listed are kept:
 * a closed issue dropping out of the loaded page and coming back is not news.
 */
export function collectInboxAlertsByEnvironment(
  previous: InboxAlertMarksByEnvironment,
  environments: ReadonlyArray<InboxEnvironmentState>,
): { readonly alerts: ScopedInboxIssue[]; readonly marks: InboxAlertMarksByEnvironment } {
  const marks = new Map(previous);
  const alerts: ScopedInboxIssue[] = [];
  for (const environment of environments) {
    const before = previous.get(environment.environmentId) ?? null;
    const result = collectInboxAlerts(before, environment.items);
    alerts.push(...result.alerts);
    marks.set(
      environment.environmentId,
      before === null ? result.marks : new Map([...before, ...result.marks]),
    );
  }
  return { alerts, marks };
}
