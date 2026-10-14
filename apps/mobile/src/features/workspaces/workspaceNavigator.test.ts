import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import type { ThreadListV2Item } from "../threads/threadListV2";
import { buildWorkspaceHomeItems, type WorkspaceHomeListItem } from "./workspaceNavigator";

const environmentId = EnvironmentId.make("env");
const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

function folder(id: string, title: string, isScratch = false) {
  return {
    projectKey: `key-${id}`,
    title,
    project: { id, title } as unknown as EnvironmentProject,
    projectCreatedAt: hoursAgo(24 * 60),
    memberKeys: [`${environmentId}:${id}`],
    isScratch,
  };
}

function thread(id: string, projectId: string, overrides: Record<string, unknown> = {}) {
  return makeThreadShellFixture({
    environmentId,
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: id,
    createdAt: hoursAgo(2),
    latestUserMessageAt: hoursAgo(2),
    ...overrides,
  });
}

function build(
  threads: ReturnType<typeof thread>[],
  toggles: ReadonlyArray<string> = [],
  options: {
    folders?: ReturnType<typeof folder>[];
    otherFolders?: ReturnType<typeof folder>[];
    projectOrder?: ReadonlyArray<string>;
  } = {},
): WorkspaceHomeListItem[] {
  return buildWorkspaceHomeItems({
    workspaceId: "w",
    folders: options.folders ?? [folder("a", "Alpha"), folder("b", "Beta")],
    ...(options.otherFolders ? { otherFolders: options.otherFolders } : {}),
    threads,
    quietAfterDays: 5,
    alwaysShow: new Set(),
    toggles: new Set(toggles),
    projectOrder: options.projectOrder ?? [],
    settlementEnvironmentIds: new Set([environmentId]),
    snoozeEnvironmentIds: new Set([environmentId]),
    queuedThreadKeys: new Set(),
    selectedThreadKey: null,
    now: NOW,
    toRow: (item: ThreadListV2Item) => ({
      type: "v2-thread",
      key: item.thread.id,
      item,
      snoozeWakeLabelText: undefined,
      timeLabel: "",
      snoozePresetMinute: undefined,
      showTrailingDivider: false,
      hasQueuedMessages: false,
      canMoveUp: false,
      canMoveDown: false,
    }),
  });
}

const outline = (items: WorkspaceHomeListItem[]) =>
  items.map((item) =>
    item.type === "ws-folder"
      ? `folder ${item.title}${item.open ? "" : " (closed)"}`
      : item.type === "ws-section"
        ? `section ${item.kind} ${item.count}`
        : item.type === "ws-more"
          ? `more ${item.label}`
          : item.type === "ws-thread"
            ? `${item.nested ? "  agent" : "thread"} ${item.item.thread.title}${item.projectLabel ? ` [${item.projectLabel}]` : ""}`
            : item.type === "ws-agents"
              ? `agents ${item.label}${item.open ? "" : " (closed)"}`
              : item.type,
  );

describe("buildWorkspaceHomeItems", () => {
  it("shows threads pinned in other workspaces, and nothing else of theirs", () => {
    const items = build(
      [
        thread("here", "a"),
        thread("pinned elsewhere", "c", { pinnedAt: hoursAgo(1) }),
        thread("unpinned elsewhere", "c"),
        thread("snoozed elsewhere", "c", {
          pinnedAt: hoursAgo(1),
          snoozedUntil: new Date(NOW + 3_600_000).toISOString(),
        }),
      ],
      [],
      { folders: [folder("a", "Alpha")], otherFolders: [folder("c", "Gamma")] },
    );
    expect(outline(items)).toEqual([
      "section pinned 1",
      "thread pinned elsewhere [Gamma]",
      "folder Alpha",
      "thread here",
    ]);
  });

  it("lays out pinned, folders, settled and quiet projects like the desktop", () => {
    const items = build([
      thread("pinned", "a", { pinnedAt: hoursAgo(1) }),
      thread("active", "a"),
      thread("settled", "a", { settledOverride: "settled", settledAt: hoursAgo(1) }),
      thread("old", "b", { createdAt: hoursAgo(24 * 30), latestUserMessageAt: hoursAgo(24 * 30) }),
    ]);
    expect(outline(items)).toEqual([
      "section pinned 1",
      "thread pinned [Alpha]",
      "folder Alpha",
      "thread active",
      "more 1 settled",
      "section quiet 1",
    ]);
  });

  it("opens folded parts from the stored toggles", () => {
    const items = build(
      [
        thread("active", "a"),
        thread("settled", "a", { settledOverride: "settled", settledAt: hoursAgo(1) }),
        thread("old", "b", {
          createdAt: hoursAgo(24 * 30),
          latestUserMessageAt: hoursAgo(24 * 30),
        }),
      ],
      ["settled:w:key-a", "quiet:w"],
    );
    expect(outline(items)).toEqual([
      "folder Alpha",
      "thread active",
      "thread settled",
      "more Hide settled",
      "section quiet 1",
      "folder Beta (closed)",
    ]);
  });

  it("hangs a thread's subagents under it, open while they work", () => {
    const agent = (id: string, parent: string, status: string) =>
      thread(id, "a", {
        lineage: { relationshipToParent: "subagent", parentThreadId: parent, rootThreadId: "lead" },
        runtime: { status },
      });
    const working = build(
      [thread("lead", "a"), agent("one", "lead", "completed"), agent("two", "lead", "running")],
      [],
      { folders: [folder("a", "Alpha")] },
    );
    expect(outline(working)).toEqual([
      "folder Alpha",
      "thread lead",
      "agents 2 agents · 1 working",
      "  agent one",
      "  agent two",
    ]);
    const done = build(
      [thread("lead", "a"), agent("one", "lead", "completed"), agent("two", "lead", "completed")],
      [],
      { folders: [folder("a", "Alpha")] },
    );
    expect(outline(done)).toEqual([
      "folder Alpha",
      "thread lead",
      "agents 2 agents · done (closed)",
    ]);
  });

  it("offers New thread in an empty folder", () => {
    const items = build([thread("x", "a")], []);
    expect(outline(items)).toContain("folder Alpha");
    const quiet = build([], ["quiet:w", "w:key-a"]);
    expect(outline(quiet)).toEqual([
      "section quiet 2",
      "folder Alpha",
      "more New thread",
      "folder Beta (closed)",
    ]);
  });

  it("keeps the user's order whatever saw activity last", () => {
    const items = build(
      [thread("fresh", "b", { latestUserMessageAt: hoursAgo(0) }), thread("older", "a")],
      [],
      { projectOrder: ["key-a", "key-b"] },
    );
    expect(outline(items).filter((line) => line.startsWith("folder"))).toEqual([
      "folder Alpha",
      "folder Beta",
    ]);
  });

  it("puts No project last, after Quiet projects and before Snoozed, and never folds it", () => {
    const items = build(
      [
        thread("old", "b", {
          createdAt: hoursAgo(24 * 30),
          latestUserMessageAt: hoursAgo(24 * 30),
        }),
        thread("chat", "s", {
          createdAt: hoursAgo(24 * 30),
          latestUserMessageAt: hoursAgo(24 * 30),
        }),
        thread("later", "a", { snoozedUntil: hoursAgo(-5) }),
      ],
      [],
      { folders: [folder("s", "No project", true), folder("a", "Alpha"), folder("b", "Beta")] },
    );
    expect(outline(items)).toEqual([
      "section quiet 2",
      "folder No project",
      "thread chat",
      "section snoozed 1",
    ]);
  });
});
