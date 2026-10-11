import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  WORKSPACE_COLORS,
  addWorkspace,
  deleteWorkspace,
  updateWorkspace,
} from "./sidebarWorkspaces";

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
