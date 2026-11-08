import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG as empty,
  type ReplicaLiveStatus,
  type SidebarProjectMount,
} from "@t3tools/contracts";
import { projectMachineStrip } from "./projectMachineStrip.ts";

const rep = (environmentId: string, role: "primary" | "replica"): SidebarProjectMount => ({
  environmentId,
  role,
  path: "/demo",
  transport: role === "primary" ? "git" : "mutagen",
  createdAt: "",
});
const group = { projectKey: "demo", environmentIds: ["lab"], knownEnvironmentIds: ["lab", "at"] };

describe("projectMachineStrip", () => {
  it.each([
    ["watching", "green", false, "synced"],
    ["pending", "neutral", true, "pending"],
    ["mounting", "neutral", true, "mounting"],
    ["conflict", "amber", false, "2 conflicts"],
    ["error", "red", false, "error"],
    ["paused", "grey", false, "paused"],
    ["removed", "grey", false, "removed"],
  ] as const)("shows %s from live status over stored status", (state, tone, pending, copy) => {
    const config = {
      ...empty,
      machines: { lab: { title: "Laptop" }, at: { title: "Studio" } },
      projectMounts: { demo: [rep("at", "replica")] },
      projectMountStatus: { demo: { at: { state: "error" as const, updatedAt: "" } } },
    };
    const live: ReplicaLiveStatus = {
      logicalKey: "demo",
      environmentId: "at",
      state,
      updatedAt: "",
      conflicts: ["a", "b"],
      problems: [],
    };
    const model = projectMachineStrip(config, group, [live]);
    expect(model.chips[0]).toMatchObject({ state, tone, pending });
    expect(model.description).toBe(`Replica on Studio (${copy})`);
    expect(projectMachineStrip(config, group, []).chips[0]?.state).toBe("error");
  });
  it("keeps skipped-file warnings visible and calm on a registered strip", () => {
    const model = projectMachineStrip(
      {
        ...empty,
        machines: { lab: { title: "Laptop" }, at: { title: "Studio" } },
        projectMounts: { demo: [rep("at", "replica")] },
        projectMountStatus: {
          demo: {
            at: {
              state: "watching",
              updatedAt: "",
              skipped: 2,
              message: "2 files skipped (unreadable files)",
            },
          },
        },
      },
      group,
      [],
    );
    expect(model.chips[0]).toMatchObject({ state: "watching", tone: "green", pending: false });
    expect(model.description).toContain("2 files skipped (unreadable files)");
  });
  it("marks a copy on a machine this client is not connected to once", () => {
    const config = {
      ...empty,
      machines: { lab: { title: "Laptop" }, at: { title: "Studio" } },
      projectMounts: { demo: [rep("lab", "primary"), rep("at", "replica")] },
    };
    const model = projectMachineStrip(
      config,
      { ...group, environmentIds: ["lab"], knownEnvironmentIds: ["lab"] },
      [],
    );
    expect(model.chips.map((chip) => [chip.environmentId, chip.muted])).toEqual([
      ["lab", false],
      ["at", true],
    ]);
    expect(new Set(model.chips.map((chip) => chip.environmentId)).size).toBe(model.chips.length);
  });

  it("orders primaries in layout order, then replicas, and counts all hidden chips", () => {
    const config = {
      ...empty,
      machines: { lab: { title: "Laptop" }, at: { title: "Studio" } },
      projectMounts: {
        demo: [
          rep("vps", "replica"),
          rep("lab", "primary"),
          rep("at", "primary"),
          rep("other", "replica"),
        ],
      },
    };
    const model = projectMachineStrip(config, group, [], (id) => ({
      label: id.toUpperCase(),
      tag: id,
      color: "#123456",
    }));
    expect(model.chips.map((chip) => chip.environmentId)).toEqual(["lab", "at", "vps"]);
    expect(model.overflow).toBe(1);
    expect(model.description).toBe(
      "Primary on LAB · Primary on AT · Replica on VPS (pending) · Replica on OTHER (pending)",
    );
  });
  it("hides single-machine strips and uses legacy members on a multi-machine client", () => {
    expect(
      projectMachineStrip(empty, { ...group, knownEnvironmentIds: ["lab"] }, []).chips,
    ).toEqual([]);
    expect(projectMachineStrip(empty, group, []).chips[0]?.environmentId).toBe("lab");
    expect(
      projectMachineStrip(
        {
          ...empty,
          machines: { at: {} },
        },
        { ...group, knownEnvironmentIds: [] },
        [],
      ).chips,
    ).toHaveLength(1);
  });
  it("shows only scratch thread machines once, ignoring representations", () => {
    const config = {
      ...empty,
      machines: { lab: { title: "Laptop" }, at: { title: "Studio" } },
      projectMounts: { demo: [rep("vps", "replica")] },
    };
    const model = projectMachineStrip(
      config,
      { ...group, isScratch: true, environmentIds: ["at", "lab", "at"] },
      [],
    );
    expect(model.chips.map((chip) => chip.environmentId)).toEqual(["at", "lab"]);
    expect(model.description).toBe("Scratch on Studio · Scratch on Laptop");
  });
});
