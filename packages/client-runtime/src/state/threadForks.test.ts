import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "./models.ts";
import {
  canForkThreadFromMenu,
  defaultForkTarget,
  nextForkTitle,
  planForkPlacement,
  runThreadFork,
} from "./threadForks.ts";
import { sortActiveThreadsByOrderKey } from "./threadSort.ts";
import { hasUsableDraftModels } from "./meshLayout/draftMachine.ts";

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

describe("defaultForkTarget", () => {
  const candidates = [
    { environmentId: "studio", connected: true, hasUsableModel: true },
    { environmentId: "cloudbox", connected: true, hasUsableModel: false },
    { environmentId: "laptop", connected: true, hasUsableModel: true },
  ];

  it("skips a connected machine without usable models", () => {
    expect(defaultForkTarget({ sourceEnvironmentId: "studio", candidates })).toBe("laptop");
  });

  it("falls back to the first other connected machine so its card explains why", () => {
    expect(
      defaultForkTarget({
        sourceEnvironmentId: "studio",
        candidates: candidates.map((candidate) => ({ ...candidate, hasUsableModel: false })),
      }),
    ).toBe("cloudbox");
  });

  it("keeps the source when it is the only machine", () => {
    expect(
      defaultForkTarget({ sourceEnvironmentId: "studio", candidates: candidates.slice(0, 1) }),
    ).toBe("studio");
  });
});

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

describe("runThreadFork", () => {
  const source = {
    environmentId: "studio" as never,
    threadId: "source" as never,
  };

  function deps(overrides: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const reorders: Array<[string, string]> = [];
    let created: EnvironmentThreadShell | null = null;
    const arrive = () => {
      created ??= shell("new", {
        title: "Work (2)",
        projectId: "project",
        activeOrderKey: "a2",
      });
    };
    return {
      calls,
      reorders,
      deps: {
        readThread: () => shell("source", { title: "Work", projectId: "project" }),
        threadsInEnvironment: () =>
          [
            shell("source", { title: "Work", projectId: "project", activeOrderKey: "a0" }),
            shell("older", { title: "Work (1)", projectId: "project", activeOrderKey: "a1" }),
            ...(created ? [created] : []),
          ] as EnvironmentThreadShell[],
        createThreadId: () => "new" as never,
        fork: async (input: { readonly title: string }) => {
          calls.push(`fork:${input.title}`);
          return { ok: true as const };
        },
        waitForThread: async () => {
          arrive();
          return true;
        },
        reorder: async (target: { readonly threadId: string }, orderKey: string) => {
          reorders.push([String(target.threadId), orderKey]);
        },
        now: () => NOW,
        ...overrides,
      },
    };
  }

  it("names, waits for and places the fork under its source", async () => {
    const setup = deps();
    const outcome = await runThreadFork(source, undefined, setup.deps as never);
    expect(outcome).toEqual({
      kind: "forked",
      target: { environmentId: "studio", threadId: "new" },
    });
    expect(setup.calls).toEqual(["fork:Work (2)"]);
    expect(setup.reorders.map(([id]) => id)).toContain("new");
  });

  it("reports a missing source without creating anything", async () => {
    const setup = deps({ readThread: () => null });
    expect(await runThreadFork(source, undefined, setup.deps as never)).toEqual({
      kind: "source-missing",
    });
    expect(setup.calls).toEqual([]);
  });

  it("keeps an interruption distinguishable from a failure", async () => {
    const setup = deps({
      fork: async () => ({ ok: false, interrupted: true, message: "stopped" }),
    });
    expect(await runThreadFork(source, undefined, setup.deps as never)).toEqual({
      kind: "interrupted",
    });
  });

  it("surfaces a fork failure message", async () => {
    const setup = deps({
      fork: async () => ({ ok: false, interrupted: false, message: "destination is offline" }),
    });
    expect(await runThreadFork(source, undefined, setup.deps as never)).toEqual({
      kind: "failed",
      message: "destination is offline",
    });
  });

  it("reports a created fork whose shell never reached this client", async () => {
    const setup = deps({ waitForThread: async () => false });
    expect(await runThreadFork(source, undefined, setup.deps as never)).toEqual({
      kind: "created-unavailable",
      target: { environmentId: "studio", threadId: "new" },
    });
    expect(setup.reorders).toEqual([]);
  });
});

describe("defaultForkTarget with the shared model resolver", () => {
  it("chooses a machine whose default model is usable, not one that merely has providers", () => {
    const laptopCatalog = {
      providers: [
        {
          instanceId: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
          auth: { status: "authenticated" },
          models: [{ slug: "fixture" }],
        },
      ],
    } as never;
    const cloudboxCatalog = {
      providers: [
        {
          instanceId: "codex",
          enabled: false,
          installed: true,
          status: "ready",
          availability: "available",
          auth: { status: "authenticated" },
          models: [{ slug: "fixture" }],
        },
      ],
    } as never;
    const candidates = [
      {
        environmentId: "studio",
        connected: true,
        hasUsableModel: hasUsableDraftModels(laptopCatalog, null),
      },
      {
        environmentId: "cloudbox",
        connected: true,
        hasUsableModel: hasUsableDraftModels(cloudboxCatalog, null),
      },
      {
        environmentId: "laptop",
        connected: true,
        hasUsableModel: hasUsableDraftModels(laptopCatalog, null),
      },
    ];
    expect(defaultForkTarget({ sourceEnvironmentId: "studio", candidates })).toBe("laptop");
  });
});
