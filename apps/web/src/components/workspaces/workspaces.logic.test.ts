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
  globToRegExp,
  isProjectQuiet,
  makeWorkspaceId,
  resolveProjectWorkspaceId,
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
