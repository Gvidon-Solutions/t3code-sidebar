import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  WORKSPACE_COLORS,
  addWorkspace,
  deleteWorkspace,
  moveProjectInOrder,
  sortWorkspaceProjects,
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
