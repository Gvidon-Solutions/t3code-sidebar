import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  WORKSPACE_COLORS,
  addWorkspace,
  deleteWorkspace,
  dropProjectOnWorkspace,
  moveProjectInOrder,
  moveProjectInWorkspace,
  projectOrderOf,
  resolveProjectWorkspaceIds,
  sortWorkspaceProjects,
  toggleProjectWorkspace,
  updateWorkspace,
} from "./sidebarWorkspaces.ts";

const config: SidebarWorkspacesConfig = {
  ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  workspaces: [
    { id: "home", name: "Home", color: WORKSPACE_COLORS[0] },
    { id: "work", name: "Work", color: WORKSPACE_COLORS[1], icon: "W" },
  ],
  assignments: { a: "work", b: "home" },
  rules: [{ match: "/work/*", workspace: "work" }],
  defaultWorkspace: null,
};

describe("workspace edits", () => {
  it("adds a workspace in an unused colour", () => {
    const added = addWorkspace(config);
    expect(added.id).toBe("workspace-3");
    expect(added.config.workspaces.at(-1)).toEqual({
      id: "workspace-3",
      name: "Workspace 3",
      color: WORKSPACE_COLORS[2],
    });
  });

  it("renames, recolours and resets the tile label", () => {
    const next = updateWorkspace(config, "work", { name: "Job", color: "#000", icon: null });
    expect(next.workspaces[1]).toEqual({ id: "work", name: "Job", color: "#000" });
    expect(next.workspaces[0]).toBe(config.workspaces[0]);
  });

  it("deletes a workspace, sending its projects to the default", () => {
    const next = deleteWorkspace(config, "work");
    expect(next.workspaces.map((workspace) => workspace.id)).toEqual(["home"]);
    expect(next.assignments).toEqual({ b: "home" });
    expect(next.rules).toEqual([]);
    expect(next.defaultWorkspace).toBe("home");
    expect(deleteWorkspace(config, "home")).toBe(config);
  });
});

describe("project order", () => {
  const project = (projectKey: string, createdAt: string) => ({ projectKey, createdAt });
  const keys = (projects: ReadonlyArray<{ projectKey: string }>) =>
    projects.map((entry) => entry.projectKey);

  it("keeps the user's order and puts unlisted projects on top, newest first", () => {
    const sorted = sortWorkspaceProjects(
      [
        project("a", "2026-01-01T00:00:00Z"),
        project("old", "2025-01-01T00:00:00Z"),
        project("b", "2026-02-01T00:00:00Z"),
        project("new", "2026-09-01T00:00:00Z"),
      ],
      ["b", "elsewhere", "a"],
      (entry) => entry,
    );
    expect(keys(sorted)).toEqual(["new", "old", "b", "a"]);
  });

  it("moves a project within its workspace and keeps other workspaces' keys", () => {
    expect(moveProjectInOrder(["x", "a", "b"], ["new", "a", "b"], "b", "new")).toEqual([
      "b",
      "new",
      "a",
      "x",
    ]);
    expect(moveProjectInOrder([], ["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    expect(moveProjectInOrder([], ["a", "b", "c"], "c", "b")).toEqual(["a", "c", "b"]);
  });
});

describe("projects in several workspaces", () => {
  const app = { projectKey: "a", workspaceRoots: ["/work/a"] };
  const scratch = { projectKey: "scratch", workspaceRoots: ["/t3/scratch"], isScratch: true };
  const desk = {
    ...config,
    workspaces: [...config.workspaces, { id: "desk", name: "Desk" }],
    projectOrder: ["b", "a"],
  };

  it("shows a project where it is placed, else in its one workspace", () => {
    expect(resolveProjectWorkspaceIds(app, desk)).toEqual(["work"]);
    expect(resolveProjectWorkspaceIds(scratch, desk)).toEqual(["home", "work", "desk"]);
    const placed = { ...desk, placements: { a: ["desk", "home", "gone"] } };
    expect(resolveProjectWorkspaceIds(app, placed)).toEqual(["home", "desk"]);
  });

  it("ticks a workspace on top of its list and never unticks the last one", () => {
    const shown = toggleProjectWorkspace(desk, app, "desk");
    expect(resolveProjectWorkspaceIds(app, shown)).toEqual(["work", "desk"]);
    expect(shown.assignments.a).toBe("work");
    expect(projectOrderOf(shown, "desk")).toEqual(["a", "b"]);
    expect(projectOrderOf(shown, "work")).toEqual(["b", "a"]);
    const hidden = toggleProjectWorkspace(shown, app, "work");
    expect(resolveProjectWorkspaceIds(app, hidden)).toEqual(["desk"]);
    expect(hidden.assignments.a).toBe("desk");
    expect(toggleProjectWorkspace(hidden, app, "desk")).toBe(hidden);
  });

  it('places "No project" like any project once it is unticked somewhere', () => {
    const next = toggleProjectWorkspace(desk, scratch, "work");
    expect(resolveProjectWorkspaceIds(scratch, next)).toEqual(["home", "desk"]);
  });

  it("moves a dropped project, or with add shows it there as well", () => {
    const moved = dropProjectOnWorkspace(desk, app, {
      fromWorkspaceId: "work",
      toWorkspaceId: "desk",
      add: false,
    });
    expect(resolveProjectWorkspaceIds(app, moved)).toEqual(["desk"]);
    const added = dropProjectOnWorkspace(desk, app, {
      fromWorkspaceId: "work",
      toWorkspaceId: "desk",
      add: true,
    });
    expect(resolveProjectWorkspaceIds(app, added)).toEqual(["work", "desk"]);
    // Moving out of one of two workspaces onto the other just leaves the first.
    const left = dropProjectOnWorkspace(added, app, {
      fromWorkspaceId: "work",
      toWorkspaceId: "desk",
      add: false,
    });
    expect(resolveProjectWorkspaceIds(app, left)).toEqual(["desk"]);
  });

  it("puts a newly shown project above what the workspace shows, unarranged ones included", () => {
    // Desk shows "new" (never arranged, so on top) and "b"; "a" must land above both.
    const shown = toggleProjectWorkspace(desk, app, "desk", () => ["new", "b"]);
    expect(projectOrderOf(shown, "desk")).toEqual(["a", "new", "b"]);
  });

  it("keeps each workspace's order its own", () => {
    const next = moveProjectInWorkspace(desk, "desk", ["b", "a"], "a", "b");
    expect(projectOrderOf(next, "desk")).toEqual(["a", "b"]);
    expect(projectOrderOf(next, "home")).toEqual(["b", "a"]);
  });

  it("drops a deleted workspace from placements; projects only there fall back", () => {
    const placed = {
      ...desk,
      placements: { a: ["work", "desk"], b: ["desk"] },
      assignments: { a: "work", b: "desk" },
      workspaceProjectOrder: { desk: ["b"] },
    };
    const next = deleteWorkspace(placed, "work");
    expect(next.placements).toEqual({ a: ["desk"], b: ["desk"] });
    expect(next.assignments).toEqual({ a: "desk", b: "desk" });
    const gone = deleteWorkspace(placed, "desk");
    expect(gone.placements).toEqual({ a: ["work"] });
    expect(gone.workspaceProjectOrder).toEqual({});
    expect(resolveProjectWorkspaceIds({ projectKey: "b", workspaceRoots: [] }, gone)).toEqual([
      "home",
    ]);
  });
});
