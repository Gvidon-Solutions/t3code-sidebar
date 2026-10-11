import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../../types";
import {
  effectiveDefaultWorkspaceId,
  globToRegExp,
  isProjectQuiet,
  isThreadUnread,
  makeWorkspaceId,
  normalizeWorkspaceLabel,
  reorderWorkspaces,
  resolveProjectWorkspaceId,
  workspaceMark,
} from "./workspaces.logic";

const config: SidebarWorkspacesConfig = {
  ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  workspaces: [
    { id: "personal", name: "personal" },
    { id: "vtbfamily", name: "vtbfamily" },
  ],
  rules: [{ match: "/home/*/repos/vtbfamily/**", workspace: "vtbfamily" }],
  defaultWorkspace: "personal",
};

const NOW = Date.parse("2026-10-10T12:00:00.000Z");

function makeThread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as SidebarThreadSummary;
}

describe("globToRegExp", () => {
  it("keeps single stars inside one segment and lets double stars cross", () => {
    expect(globToRegExp("/repos/*").test("/repos/a")).toBe(true);
    expect(globToRegExp("/repos/*").test("/repos/a/b")).toBe(false);
    expect(globToRegExp("/repos/**").test("/repos/a/b")).toBe(true);
    expect(globToRegExp("/repos/a.b").test("/repos/axb")).toBe(false);
  });
});

describe("resolveProjectWorkspaceId", () => {
  it("prefers an explicit assignment over rules", () => {
    expect(
      resolveProjectWorkspaceId(
        { projectKey: "p1", workspaceRoots: ["/home/t3/repos/vtbfamily/web"] },
        { ...config, assignments: { p1: "personal" } },
      ),
    ).toBe("personal");
  });

  it("falls back from rules to the default workspace", () => {
    expect(
      resolveProjectWorkspaceId(
        { projectKey: "p1", workspaceRoots: ["/home/t3/repos/vtbfamily/web"] },
        config,
      ),
    ).toBe("vtbfamily");
    expect(
      resolveProjectWorkspaceId({ projectKey: "p2", workspaceRoots: ["/srv/other"] }, config),
    ).toBe("personal");
  });

  it("ignores assignments to deleted workspaces", () => {
    expect(
      resolveProjectWorkspaceId(
        { projectKey: "p1", workspaceRoots: ["/srv/x"] },
        { ...config, assignments: { p1: "gone" } },
      ),
    ).toBe("personal");
  });

  it("returns null without workspaces", () => {
    expect(
      resolveProjectWorkspaceId(
        { projectKey: "p1", workspaceRoots: ["/srv/x"] },
        DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
      ),
    ).toBeNull();
  });
});

describe("isProjectQuiet", () => {
  const base = { projectCreatedAt: "2026-01-01T00:00:00.000Z", quietAfterDays: 5, now: NOW };

  it("is quiet when every active thread is older than the horizon", () => {
    expect(isProjectQuiet({ ...base, alwaysShow: false, threads: [makeThread()] })).toBe(true);
  });

  it("stays loud for recent, pinned or blocked threads", () => {
    const recent = makeThread({ latestUserMessageAt: "2026-10-09T10:00:00.000Z" });
    const pinned = makeThread({ pinnedAt: "2026-09-01T00:00:00.000Z" });
    const blocked = makeThread({ hasPendingApprovals: true });
    for (const thread of [recent, pinned, blocked]) {
      expect(isProjectQuiet({ ...base, alwaysShow: false, threads: [thread] })).toBe(false);
    }
  });

  it("does not count settled threads as activity", () => {
    const settled = makeThread({
      settledOverride: "settled",
      latestUserMessageAt: "2026-10-09T10:00:00.000Z",
    });
    expect(isProjectQuiet({ ...base, alwaysShow: false, threads: [settled] })).toBe(true);
  });

  it("keeps a fresh empty project and always-show projects loud", () => {
    expect(
      isProjectQuiet({
        ...base,
        projectCreatedAt: "2026-10-09T00:00:00.000Z",
        alwaysShow: false,
        threads: [],
      }),
    ).toBe(false);
    expect(isProjectQuiet({ ...base, alwaysShow: true, threads: [makeThread()] })).toBe(false);
  });
});

describe("makeWorkspaceId", () => {
  it("slugs names and avoids taken ids", () => {
    expect(makeWorkspaceId("Potential Plus", new Set())).toBe("potential-plus");
    expect(makeWorkspaceId("work", new Set(["work"]))).toBe("work-2");
  });
});

describe("effectiveDefaultWorkspaceId", () => {
  it("uses the configured default and falls back to the first workspace", () => {
    expect(effectiveDefaultWorkspaceId(config)).toBe("personal");
    expect(effectiveDefaultWorkspaceId({ ...config, defaultWorkspace: "gone" })).toBe("personal");
    expect(effectiveDefaultWorkspaceId({ ...config, defaultWorkspace: "vtbfamily" })).toBe(
      "vtbfamily",
    );
  });
});

describe("reorderWorkspaces", () => {
  const ids = (list: readonly { id: string }[]) => list.map((entry) => entry.id);
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("moves a workspace before the given slot", () => {
    expect(ids(reorderWorkspaces(list, "a", 3))).toEqual(["b", "c", "a", "d"]);
    expect(ids(reorderWorkspaces(list, "a", 4))).toEqual(["b", "c", "d", "a"]);
    expect(ids(reorderWorkspaces(list, "d", 0))).toEqual(["d", "a", "b", "c"]);
    expect(ids(reorderWorkspaces(list, "c", 1))).toEqual(["a", "c", "b", "d"]);
  });

  it("returns the same order for no-op moves and unknown ids", () => {
    expect(reorderWorkspaces(list, "b", 1)).toBe(list);
    expect(reorderWorkspaces(list, "b", 2)).toBe(list);
    expect(reorderWorkspaces(list, "zz", 0)).toBe(list);
  });
});

describe("workspace tile marks", () => {
  it("keeps at most two characters, counting an emoji as one", () => {
    expect(normalizeWorkspaceLabel("  vtb ")).toBe("vt");
    expect(normalizeWorkspaceLabel("👨‍👩‍👧x")).toBe("👨‍👩‍👧x");
    expect(normalizeWorkspaceLabel("   ")).toBeNull();
  });

  it("shows a glyph, the custom label or the first letter", () => {
    expect(workspaceMark({ name: "edu", icon: "glyph:graduation" })).toEqual({
      kind: "glyph",
      glyph: "graduation",
    });
    expect(workspaceMark({ name: "potentialplus", icon: "P+" })).toEqual({
      kind: "text",
      text: "P+",
    });
    expect(workspaceMark({ name: "personal" })).toEqual({ kind: "text", text: "P" });
  });
});

describe("isThreadUnread", () => {
  const done = makeThread({
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-10-10T10:00:00.000Z",
      startedAt: "2026-10-10T10:00:00.000Z",
      completedAt: "2026-10-10T11:00:00.000Z",
      assistantMessageId: null,
    } as SidebarThreadSummary["latestTurn"],
  });

  it("counts a never-opened thread from the device baseline", () => {
    expect(isThreadUnread(done, undefined, "2026-10-10T09:00:00.000Z")).toBe(true);
    expect(isThreadUnread(done, undefined, "2026-10-10T12:00:00.000Z")).toBe(false);
    expect(isThreadUnread(done, undefined, null)).toBe(false);
  });

  it("clears once the completion has been seen", () => {
    expect(isThreadUnread(done, "2026-10-10T11:00:00.000Z", "2026-10-10T09:00:00.000Z")).toBe(
      false,
    );
    expect(isThreadUnread(done, "2026-10-10T10:30:00.000Z", null)).toBe(true);
  });
});
