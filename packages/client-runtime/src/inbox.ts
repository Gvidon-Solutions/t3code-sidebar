import {
  type EnvironmentId,
  INBOX_SEVERITY_RANK,
  type InboxIssue,
  isInboxIssueUnread,
} from "@t3tools/contracts";

/** Fork: agent inbox. One list across every connected environment, shared by web and mobile. */
export interface ScopedInboxIssue {
  readonly environmentId: EnvironmentId;
  /** The machine the issue lives on, shown on the card. */
  readonly environmentLabel: string;
  readonly issue: InboxIssue;
}

export const inboxIssueKey = (item: Pick<ScopedInboxIssue, "environmentId" | "issue">) =>
  `${item.environmentId}:${item.issue.id}`;

/**
 * Open issues first: action, then attention, then info, each newest activity
 * first (a daily reminder counts as activity). Closed issues follow, newest
 * closed first.
 */
export function sortInboxIssues(items: ReadonlyArray<ScopedInboxIssue>): ScopedInboxIssue[] {
  return [...items].sort((a, b) => {
    const aOpen = a.issue.state === "open";
    const bOpen = b.issue.state === "open";
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    if (aOpen) {
      const rank = INBOX_SEVERITY_RANK[b.issue.severity] - INBOX_SEVERITY_RANK[a.issue.severity];
      if (rank !== 0) return rank;
      return b.issue.activityAt.localeCompare(a.issue.activityAt);
    }
    return (b.issue.closedAt ?? "").localeCompare(a.issue.closedAt ?? "");
  });
}

/** The two counters on the inbox icon. */
export interface InboxCounts {
  /** Blue: issues with something the owner has not seen. */
  readonly unread: number;
  /** Red: open issues waiting for the owner's answer; reading does not clear it. */
  readonly waiting: number;
}

export function countInbox(items: ReadonlyArray<ScopedInboxIssue>): InboxCounts {
  let unread = 0;
  let waiting = 0;
  for (const { issue } of items) {
    if (isInboxIssueUnread(issue)) unread += 1;
    if (issue.state === "open" && issue.waitingForOwner) waiting += 1;
  }
  return { unread, waiting };
}

/** What the last snapshot announced, per issue key. */
export type InboxAlertMarks = ReadonlyMap<string, number>;

/**
 * Issues with news to announce since `previous`. The first snapshot a client
 * sees only sets the marks, so opening the app does not replay old news; an
 * issue the owner already saw is never announced.
 */
export function collectInboxAlerts(
  previous: InboxAlertMarks | null,
  items: ReadonlyArray<ScopedInboxIssue>,
): { readonly alerts: ScopedInboxIssue[]; readonly marks: InboxAlertMarks } {
  const marks = new Map<string, number>();
  const alerts: ScopedInboxIssue[] = [];
  for (const item of items) {
    const key = inboxIssueKey(item);
    marks.set(key, item.issue.alertSequence);
    if (previous === null) continue;
    const before = previous.get(key) ?? 0;
    if (item.issue.alertSequence > before && item.issue.alertSequence > item.issue.seenSequence) {
      alerts.push(item);
    }
  }
  return { alerts, marks };
}

/** Notification text for an announced issue. */
export function inboxAlertTitle(issue: InboxIssue): string {
  const mark = issue.severity === "action" ? "🔴" : issue.severity === "attention" ? "🟡" : "⚪";
  return `${mark} ${issue.title}`;
}
