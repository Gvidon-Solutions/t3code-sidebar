import {
  EnvironmentId,
  type InboxEntry,
  InboxEntryId,
  type InboxIssue,
  InboxIssueId,
  type InboxSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectInboxAlertsByEnvironment,
  describeInboxEvent,
  groupInboxIssuesBySeverity,
  inboxButtonLabel,
  inboxDeliveryFailure,
  mergeInboxEnvironments,
} from "./inbox.logic";

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

const snapshot = (issues: InboxIssue[], closedTotal = 0): InboxSnapshot => ({
  issues,
  closedTotal,
});

const entry = (overrides: Partial<InboxEntry>): InboxEntry => ({
  id: InboxEntryId.make("entry"),
  issueId: InboxIssueId.make("issue"),
  sequence: 1,
  kind: "comment",
  author: "agent",
  threadId: null,
  text: null,
  createdAt: "2026-10-15T08:00:00.000Z",
  deliveries: [],
  ...overrides,
});

describe("mergeInboxEnvironments", () => {
  it("makes one sorted list across machines with counts and closed totals", () => {
    const state = mergeInboxEnvironments(
      [
        {
          environmentId: gvidon,
          environmentLabel: "gvidon",
          snapshot: snapshot(
            [
              issue("info"),
              issue("done", { state: "resolved", closedAt: "2026-10-15T09:00:00.000Z" }),
            ],
            40,
          ),
        },
        {
          environmentId: gor,
          environmentLabel: "gor",
          snapshot: snapshot([issue("action", { severity: "action", waitingForOwner: true })], 2),
        },
      ],
      null,
    );
    expect(state.items.map((item) => [item.environmentLabel, item.issue.id])).toEqual([
      ["gor", "action"],
      ["gvidon", "info"],
      ["gvidon", "done"],
    ]);
    expect(state.open).toHaveLength(2);
    expect(state.closed).toHaveLength(1);
    expect(state.closedTotal).toBe(42);
    expect(state.counts).toEqual({ unread: 3, waiting: 1 });
  });

  it("keeps unchanged issues and the whole state when a snapshot repeats", () => {
    const first = mergeInboxEnvironments(
      [
        {
          environmentId: gvidon,
          environmentLabel: "gvidon",
          snapshot: snapshot([issue("a", { threadIds: [ThreadId.make("t1")] }), issue("b")]),
        },
      ],
      null,
    );
    // A fresh decode of the same data: new objects, same values.
    const same = mergeInboxEnvironments(
      [
        {
          environmentId: gvidon,
          environmentLabel: "gvidon",
          snapshot: snapshot([issue("a", { threadIds: [ThreadId.make("t1")] }), issue("b")]),
        },
      ],
      first,
    );
    expect(same).toBe(first);

    const changed = mergeInboxEnvironments(
      [
        {
          environmentId: gvidon,
          environmentLabel: "gvidon",
          snapshot: snapshot([
            issue("a", { threadIds: [ThreadId.make("t1")] }),
            issue("b", { lastSequence: 2, notableSequence: 2 }),
          ]),
        },
      ],
      first,
    );
    expect(changed).not.toBe(first);
    const a = (state: typeof first) => state.items.find((item) => item.issue.id === "a");
    const b = (state: typeof first) => state.items.find((item) => item.issue.id === "b");
    expect(a(changed)).toBe(a(first));
    expect(b(changed)).not.toBe(b(first));
  });
});

describe("collectInboxAlertsByEnvironment", () => {
  it("does not replay a late environment's old news, and announces what is new", () => {
    const gvidonOnly = mergeInboxEnvironments(
      [{ environmentId: gvidon, environmentLabel: "gvidon", snapshot: snapshot([issue("a")]) }],
      null,
    );
    const first = collectInboxAlertsByEnvironment(new Map(), gvidonOnly.environments);
    expect(first.alerts).toEqual([]);

    // gor connects later with an unseen issue: its first snapshot only sets marks.
    const both = mergeInboxEnvironments(
      [
        { environmentId: gvidon, environmentLabel: "gvidon", snapshot: snapshot([issue("a")]) },
        { environmentId: gor, environmentLabel: "gor", snapshot: snapshot([issue("old")]) },
      ],
      gvidonOnly,
    );
    const second = collectInboxAlertsByEnvironment(first.marks, both.environments);
    expect(second.alerts).toEqual([]);

    const news = mergeInboxEnvironments(
      [
        {
          environmentId: gvidon,
          environmentLabel: "gvidon",
          snapshot: snapshot([issue("a"), issue("new")]),
        },
        { environmentId: gor, environmentLabel: "gor", snapshot: snapshot([issue("old")]) },
      ],
      both,
    );
    const third = collectInboxAlertsByEnvironment(second.marks, news.environments);
    expect(third.alerts.map((item) => item.issue.id)).toEqual(["new"]);
  });

  it("keeps marks of issues that drop out of the loaded page", () => {
    const withClosed = mergeInboxEnvironments(
      [
        {
          environmentId: gvidon,
          environmentLabel: "gvidon",
          snapshot: snapshot([issue("closed", { state: "resolved", alertSequence: 3 })]),
        },
      ],
      null,
    );
    const first = collectInboxAlertsByEnvironment(new Map(), withClosed.environments);
    const without = mergeInboxEnvironments(
      [{ environmentId: gvidon, environmentLabel: "gvidon", snapshot: snapshot([]) }],
      withClosed,
    );
    const second = collectInboxAlertsByEnvironment(first.marks, without.environments);
    const back = mergeInboxEnvironments(
      [
        {
          environmentId: gvidon,
          environmentLabel: "gvidon",
          snapshot: snapshot([issue("closed", { state: "resolved", alertSequence: 3 })]),
        },
      ],
      without,
    );
    expect(collectInboxAlertsByEnvironment(second.marks, back.environments).alerts).toEqual([]);
  });
});

describe("groupInboxIssuesBySeverity", () => {
  it("orders groups action, attention, info and leaves empty ones out", () => {
    const state = mergeInboxEnvironments(
      [
        {
          environmentId: gvidon,
          environmentLabel: "gvidon",
          snapshot: snapshot([issue("i"), issue("x", { severity: "action" })]),
        },
      ],
      null,
    );
    expect(groupInboxIssuesBySeverity(state.open).map((group) => group.severity)).toEqual([
      "action",
      "info",
    ]);
  });
});

describe("inbox presentation", () => {
  it("labels the sidebar button with both counters", () => {
    expect(inboxButtonLabel({ unread: 0, waiting: 0 })).toBe("Inbox");
    expect(inboxButtonLabel({ unread: 2, waiting: 1 })).toBe("Inbox · 2 new · 1 needs your answer");
    expect(inboxButtonLabel({ unread: 0, waiting: 3 })).toBe("Inbox · 3 need your answer");
  });

  it("describes history events", () => {
    expect(
      describeInboxEvent(entry({ kind: "updated", text: "severity attention → action" })),
    ).toMatchObject({ label: "Updated: severity attention → action" });
    expect(
      describeInboxEvent(entry({ kind: "resolved", text: "Pinned the model; verified." })),
    ).toEqual({ label: "Resolved", detail: "Pinned the model; verified.", tone: "success" });
    expect(
      describeInboxEvent(entry({ kind: "reopened", text: "Previous resolution: x" })),
    ).toMatchObject({ label: "The problem came back", detail: "Previous resolution: x" });
  });

  it("reports the first failed delivery", () => {
    const thread = ThreadId.make("t1");
    expect(
      inboxDeliveryFailure(entry({ deliveries: [{ threadId: thread, status: "delivered" }] })),
    ).toBeNull();
    expect(
      inboxDeliveryFailure(
        entry({ deliveries: [{ threadId: thread, status: "failed", error: "Thread deleted" }] }),
      ),
    ).toBe("Thread deleted");
  });
});
