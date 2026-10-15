import { EnvironmentId, type InboxIssue, InboxIssueId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectInboxAlerts, countInbox, type ScopedInboxIssue, sortInboxIssues } from "./inbox.ts";

const gvidon = EnvironmentId.make("env-gvidon");
const gor = EnvironmentId.make("env-gor");

const issue = (id: string, overrides: Partial<InboxIssue> = {}): InboxIssue => ({
  id: InboxIssueId.make(id),
  severity: "info",
  title: id,
  description: "",
  state: "open",
  waitingForOwner: false,
  waitingSince: null,
  projectId: null,
  responsibleThreadId: null,
  creatorThreadId: null,
  threadIds: [],
  source: { kind: "client", label: "t3ctl" },
  dedupeKey: null,
  repeatCount: 0,
  createdAt: "2026-10-15T08:00:00.000Z",
  updatedAt: "2026-10-15T08:00:00.000Z",
  activityAt: "2026-10-15T08:00:00.000Z",
  closedAt: null,
  closedBy: null,
  closeNote: null,
  lastSequence: 1,
  notableSequence: 1,
  alertSequence: 1,
  seenSequence: 0,
  ...overrides,
});

const on = (environmentId: EnvironmentId, value: InboxIssue): ScopedInboxIssue => ({
  environmentId,
  environmentLabel: environmentId === gvidon ? "gvidon" : "gor",
  issue: value,
});

describe("sortInboxIssues", () => {
  it("puts open issues first by severity and activity, then closed ones by close time", () => {
    const sorted = sortInboxIssues([
      on(gvidon, issue("info-new", { activityAt: "2026-10-15T12:00:00.000Z" })),
      on(gor, issue("resolved-old", { state: "resolved", closedAt: "2026-10-14T00:00:00.000Z" })),
      on(gvidon, issue("action-old", { severity: "action" })),
      on(gor, issue("attention", { severity: "attention" })),
      // A daily reminder bumps activity, so it rises within its severity.
      on(
        gor,
        issue("action-reminded", { severity: "action", activityAt: "2026-10-15T09:00:00.000Z" }),
      ),
      on(
        gvidon,
        issue("dismissed-new", { state: "dismissed", closedAt: "2026-10-15T00:00:00.000Z" }),
      ),
    ]);
    expect(sorted.map((item) => item.issue.id)).toEqual([
      "action-reminded",
      "action-old",
      "attention",
      "info-new",
      "dismissed-new",
      "resolved-old",
    ]);
  });
});

describe("countInbox", () => {
  it("counts unread issues and open issues waiting for an answer separately", () => {
    expect(
      countInbox([
        // Read but still waiting: reading is not answering.
        on(gvidon, issue("read-waiting", { waitingForOwner: true, seenSequence: 1 })),
        on(gor, issue("unread", { seenSequence: 0 })),
        // A resolution the owner has not seen is news; it no longer waits.
        on(
          gor,
          issue("resolved-unread", { state: "resolved", notableSequence: 3, seenSequence: 2 }),
        ),
      ]),
    ).toEqual({ unread: 2, waiting: 1 });
  });
});

describe("collectInboxAlerts", () => {
  it("announces only news that arrives after the first snapshot and is not yet seen", () => {
    const first = collectInboxAlerts(null, [on(gvidon, issue("old"))]);
    expect(first.alerts).toEqual([]);

    const next = collectInboxAlerts(first.marks, [
      on(gvidon, issue("old")),
      on(gor, issue("new")),
      // Same id on another machine is another issue.
      on(gor, issue("old", { alertSequence: 1 })),
      // Seen on another device before this client heard of it.
      on(gvidon, issue("seen", { alertSequence: 2, seenSequence: 2 })),
    ]);
    expect(next.alerts.map((item) => `${item.environmentLabel}:${item.issue.id}`)).toEqual([
      "gor:new",
      "gor:old",
    ]);

    const reminder = collectInboxAlerts(next.marks, [
      // A reminder raises notableSequence but not alertSequence: no sound.
      on(gvidon, issue("old", { lastSequence: 2, notableSequence: 2 })),
    ]);
    expect(reminder.alerts).toEqual([]);
  });
});
