import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG as empty,
  type ReplicaLiveStatus,
  type SidebarProjectMount,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";

import {
  folderMachineChoices,
  folderPendingRows,
  machineMenuItems,
  primarySeedOf,
} from "./replicas.logic";

const primary = (environmentId: string): SidebarProjectMount => ({
  environmentId,
  path: "/work/demo",
  projectId: `project-${environmentId}`,
  transport: "git",
  role: "primary",
  createdAt: "",
});

const replica = (environmentId: string, source: string): SidebarProjectMount => ({
  environmentId,
  path: "/work/demo",
  transport: "mutagen",
  role: "replica",
  source,
  createdAt: "",
});

const config: SidebarWorkspacesConfig = {
  ...empty,
  machines: {
    alpha: { label: "gvidon", tag: "GV" },
    beta: { label: "Operalia", tag: "OP" },
  },
  projectMounts: { demo: [primary("alpha"), replica("beta", "alpha")] },
};

const live = (environmentId: string, patch: Partial<ReplicaLiveStatus>): ReplicaLiveStatus => ({
  logicalKey: "demo",
  environmentId,
  state: "mounting",
  conflicts: [],
  problems: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

describe("folderMachineChoices", () => {
  it("lists connected machines with their tags and disables servers without the mesh", () => {
    const choices = folderMachineChoices(config, [
      { environmentId: "alpha", label: "gvidon", connected: true, supportsMesh: true },
      { environmentId: "beta", label: "Operalia", connected: true, supportsMesh: false },
      { environmentId: "gamma", label: "gor", connected: false, supportsMesh: true },
    ]);
    expect(choices.map((choice) => [choice.tag, choice.label])).toEqual([
      ["GV", "gvidon"],
      ["OP", "Operalia"],
    ]);
    expect(choices[1]?.disabled).toBe(true);
  });
});

describe("machineMenuItems", () => {
  it("puts the reason into a disabled item's label", () => {
    const items = machineMenuItems(
      folderMachineChoices(config, [
        { environmentId: "alpha", label: "gvidon", connected: true, supportsMesh: true },
        { environmentId: "beta", label: "Operalia", connected: true, supportsMesh: false },
      ]),
    );
    expect(items).toEqual([
      { id: "machine:alpha", label: "GV  gvidon", disabled: false },
      {
        id: "machine:beta",
        label: "OP  Operalia (update this server to use the mesh)",
        disabled: true,
      },
    ]);
  });
});

describe("folderPendingRows", () => {
  it("keeps only the folder's own unregistered representations with live status", () => {
    const rows = folderPendingRows(config, [live("beta", { progress: 0.42 })], "demo");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rep.environmentId).toBe("beta");
    expect(rows[0]?.progress).toBe(0.42);
    expect(folderPendingRows(config, [], "other")).toEqual([]);
  });
});

describe("primarySeedOf", () => {
  const members = [
    { environmentId: "alpha", id: "p1", workspaceRoot: "/work/demo" },
    { environmentId: "beta", id: "p2", workspaceRoot: "/srv/demo" },
  ];
  it("prefers the primary machine's folder and falls back to the first member", () => {
    expect(primarySeedOf(members, "beta")).toEqual({
      environmentId: "beta",
      path: "/srv/demo",
      projectId: "p2",
    });
    expect(primarySeedOf(members, null)?.projectId).toBe("p1");
    expect(primarySeedOf([], "alpha")).toBeNull();
  });
});
