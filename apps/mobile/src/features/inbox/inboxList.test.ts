import {
  EnvironmentId,
  InboxEntryId,
  InboxIssueId,
  type InboxEntry,
  type InboxIssue,
  type InboxSeverity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildOpenInboxRows,
  mergeInboxSources,
  presentInboxEntry,
  type InboxSource,
} from "./inboxList";

const gvidon = EnvironmentId.make("gvidon");
const gor = EnvironmentId.make("gor");

function issue(
  id: string,
  overrides: Partial<Pick<InboxIssue, "state" | "severity" | "activityAt" | "closedAt">> = {},
): InboxIssue {
  return {
    id: InboxIssueId.make(id),
    severity: "info" as InboxSeverity,
    title: id,
    description: "",
    state: "open",
    waitingForOwner: false,
    waitingSince: null,
    projectId: null,
    responsibleThreadId: null,
    creatorThreadId: null,
    threadIds: [],
    source: { kind: "client", label: "test" },
    dedupeKey: null,
    repeatCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    activityAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    closedBy: null,
    closeNote: null,
    lastSequence: 1,
    notableSequence: 1,
    alertSequence: 1,
    seenSequence: 1,
    ...overrides,
  };
}

const closed = (id: string, day: number) =>
  issue(id, {
    state: "resolved",
    closedAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`,
  });

function source(
  environmentId: EnvironmentId,
  issues: InboxIssue[] | null,
  closedTotal = 0,
  pending = false,
): InboxSource {
  return {
    environmentId,
    environmentLabel: environmentId,
    snapshot: issues === null ? null : { issues, closedTotal },
    pending,
  };
}

describe("mergeInboxSources", () => {
  it("merges machines, keeps each issue's machine, and skips ones without an inbox", () => {
    const state = mergeInboxSources(
      [
        source(gvidon, [issue("a", { severity: "info" })]),
        source(gor, [issue("b", { severity: "action" })]),
        source(EnvironmentId.make("old"), null),
      ],
      30,
    );
    expect(state.open.map((item) => [item.environmentId, item.issue.id])).toEqual([
      [gor, "b"],
      [gvidon, "a"],
    ]);
    expect(state.isLoading).toBe(false);
  });

  it("keeps the newest closed issues across machines within the page", () => {
    const state = mergeInboxSources(
      [
        source(gvidon, [closed("g1", 1), closed("g5", 5)], 7),
        source(gor, [closed("r3", 3), closed("r9", 9)], 4),
      ],
      3,
    );
    expect(state.closed.map((item) => item.issue.id)).toEqual(["r9", "g5", "r3"]);
    expect(state.closedTotal).toBe(11);
  });

  it("is loading only while nothing has arrived from a connected machine", () => {
    expect(mergeInboxSources([source(gvidon, null, 0, true)], 30).isLoading).toBe(true);
    expect(
      mergeInboxSources([source(gvidon, null, 0, true), source(gor, [issue("a")])], 30).isLoading,
    ).toBe(false);
    expect(mergeInboxSources([source(gvidon, null)], 30).isLoading).toBe(false);
  });
});

describe("buildOpenInboxRows", () => {
  it("puts one header with its count before each severity run", () => {
    const { open } = mergeInboxSources(
      [
        source(gvidon, [
          issue("i1", { severity: "info" }),
          issue("a1", { severity: "action" }),
          issue("a2", { severity: "action", activityAt: "2026-10-02T00:00:00.000Z" }),
        ]),
      ],
      30,
    );
    expect(
      buildOpenInboxRows(open).map((row) =>
        row.kind === "section" ? `${row.severity}:${row.count}` : row.item.issue.id,
      ),
    ).toEqual(["action:2", "a2", "a1", "info:1", "i1"]);
  });
});

describe("presentInboxEntry", () => {
  const entry = (kind: InboxEntry["kind"], text: string | null = null): InboxEntry => ({
    id: InboxEntryId.make(`e-${kind}`),
    issueId: InboxIssueId.make("i"),
    sequence: 1,
    kind,
    author: kind === "comment" ? "owner" : "agent",
    threadId: null,
    text,
    createdAt: "2026-10-01T00:00:00.000Z",
    deliveries: [],
  });

  it("reads how an issue ended as an outcome, with its note under the label", () => {
    expect(presentInboxEntry(entry("resolved", " Renewed the certificate. "))).toEqual({
      kind: "event",
      label: "Resolved",
      detail: "Renewed the certificate.",
      tone: "outcome",
    });
    expect(presentInboxEntry(entry("dismissed", "Moved to gor"))).toMatchObject({
      label: "Closed as not relevant",
      detail: "Moved to gor",
      tone: "outcome",
    });
  });

  it("keeps bookkeeping quiet and an attachments-only comment empty", () => {
    expect(presentInboxEntry(entry("created", "Disk at 92%"))).toMatchObject({
      label: "Issue raised",
      detail: null,
      tone: "muted",
    });
    expect(presentInboxEntry(entry("comment"))).toEqual({
      kind: "comment",
      side: "owner",
      text: "",
    });
  });
});
