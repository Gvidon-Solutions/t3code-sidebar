import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "./models.ts";
import { canForkThreadFromMenu, nextForkTitle, planForkPlacement } from "./threadForks.ts";
import { sortActiveThreadsByOrderKey } from "./threadSort.ts";

const NOW = "2026-10-12T12:00:00.000Z";

function shell(
  id: string,
  overrides: Partial<Record<keyof EnvironmentThreadShell, unknown>> = {},
): EnvironmentThreadShell {
  return {
    id,
    title: id,
    providerInstanceId: "codex",
    latestRun: { status: "completed" },
    visibleItemCount: 4,
    source: {},
    lineage: { relationshipToParent: null },
    createdAt: "2026-10-01T00:00:00.000Z",
    unsettledAt: null,
    archivedAt: null,
    deletedAt: null,
    pinnedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    snoozedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    activeOrderKey: null,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

/** The active order after applying the planned writes. */
function orderAfter(threads: EnvironmentThreadShell[], sourceId: string, forkId: string) {
  const writes = new Map(
    planForkPlacement({ threads, sourceId, forkId, now: NOW }).map((write) => [
      write.id,
      write.orderKey,
    ]),
  );
  return sortActiveThreadsByOrderKey(
    threads.map((thread) =>
      writes.has(thread.id) ? { ...thread, activeOrderKey: writes.get(thread.id)! } : thread,
    ),
  ).map((thread) => thread.id);
}

describe("nextForkTitle", () => {
  it("numbers forks of one thread consecutively", () => {
    expect(nextForkTitle("Fix login", ["Fix login"])).toBe("Fix login (1)");
    expect(nextForkTitle("Fix login", ["Fix login", "Fix login (1)", "Fix login (2)"])).toBe(
      "Fix login (3)",
    );
  });

  it("counts a fork of a fork from the base title", () => {
    expect(nextForkTitle("Fix login (2)", ["Fix login", "Fix login (1)", "Fix login (2)"])).toBe(
      "Fix login (3)",
    );
  });

  it("ignores titles that only share a prefix", () => {
    expect(nextForkTitle("Fix", ["Fix login (4)", "Fix"])).toBe("Fix (1)");
  });
});

describe("canForkThreadFromMenu", () => {
  const providers = [
    { instanceId: "codex-luna", driver: "codex" },
    { instanceId: "claude", driver: "claudeAgent" },
    { instanceId: "cursor", driver: "cursor" },
  ] as never;

  it("offers Codex and Claude threads that have a run", () => {
    expect(canForkThreadFromMenu(shell("a", { providerInstanceId: "codex-luna" }), providers)).toBe(
      true,
    );
    expect(canForkThreadFromMenu(shell("a", { providerInstanceId: "claude" }), providers)).toBe(
      true,
    );
    expect(canForkThreadFromMenu(shell("a", { providerInstanceId: "cursor" }), providers)).toBe(
      false,
    );
    expect(canForkThreadFromMenu(shell("a", { latestRun: null }), providers)).toBe(false);
    expect(
      canForkThreadFromMenu(
        shell("a", { latestRun: null, source: { historyOrigin: "v1_import" } }),
        providers,
      ),
    ).toBe(true);
  });
});

describe("planForkPlacement", () => {
  it("puts the fork right under a keyless source", () => {
    const threads = [
      shell("old", { createdAt: "2026-10-01T00:00:00.000Z" }),
      shell("source", { createdAt: "2026-10-05T00:00:00.000Z" }),
      shell("fork", { createdAt: NOW }),
    ];
    expect(orderAfter(threads, "source", "fork")).toEqual(["source", "fork", "old"]);
  });

  it("writes one key between keyed neighbors", () => {
    const threads = [
      shell("a", { activeOrderKey: "b" }),
      shell("source", { activeOrderKey: "m" }),
      shell("c", { activeOrderKey: "t" }),
      shell("fork", { createdAt: NOW, activeOrderKey: "m" }),
    ];
    const writes = planForkPlacement({ threads, sourceId: "source", forkId: "fork", now: NOW });
    expect(writes.map((write) => write.id)).toEqual(["fork"]);
    expect(orderAfter(threads, "source", "fork")).toEqual(["a", "source", "fork", "c"]);
  });

  it("lines a new fork up after the source's earlier forks", () => {
    const threads = [
      shell("source", { activeOrderKey: "m" }),
      shell("fork1", {
        activeOrderKey: "p",
        lineage: { relationshipToParent: "fork", parentThreadId: "source" },
      }),
      shell("next", { activeOrderKey: "t" }),
      shell("fork2", { createdAt: NOW }),
    ];
    expect(orderAfter(threads, "source", "fork2")).toEqual(["source", "fork1", "fork2", "next"]);
  });

  it("leaves the fork on top when the source is pinned", () => {
    const threads = [
      shell("a"),
      shell("source", { pinnedAt: NOW }),
      shell("fork", { createdAt: NOW }),
    ];
    expect(planForkPlacement({ threads, sourceId: "source", forkId: "fork", now: NOW })).toEqual(
      [],
    );
  });
});
