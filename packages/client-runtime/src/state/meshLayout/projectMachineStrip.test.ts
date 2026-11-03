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
const group = { projectKey: "demo", environmentIds: ["gor"], knownEnvironmentIds: ["gor", "gv"] };

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
      projectMounts: { demo: [rep("gv", "replica")] },
      projectMountStatus: { demo: { gv: { state: "error" as const, updatedAt: "" } } },
    };
    const live: ReplicaLiveStatus = {
      logicalKey: "demo",
      environmentId: "gv",
      state,
      updatedAt: "",
      conflicts: ["a", "b"],
      problems: [],
    };
    const model = projectMachineStrip(config, group, [live]);
    expect(model.chips[0]).toMatchObject({ state, tone, pending });
    expect(model.description).toBe(`Replica on gv (${copy})`);
    expect(projectMachineStrip(config, group, []).chips[0]?.state).toBe("error");
  });
  it("orders primaries in layout order, then replicas, and counts all hidden chips", () => {
    const config = {
      ...empty,
      projectMounts: {
        demo: [
          rep("vps", "replica"),
          rep("gor", "primary"),
          rep("gv", "primary"),
          rep("other", "replica"),
        ],
      },
    };
    const model = projectMachineStrip(config, group, [], (id) => ({
      label: id.toUpperCase(),
      tag: id,
      color: "#123456",
    }));
    expect(model.chips.map((chip) => chip.environmentId)).toEqual(["gor", "gv", "vps"]);
    expect(model.overflow).toBe(1);
    expect(model.description).toBe(
      "Primary on GOR · Primary on GV · Replica on VPS (pending) · Replica on OTHER (pending)",
    );
  });
  it("hides single-machine strips and uses legacy members on a multi-machine client", () => {
    expect(
      projectMachineStrip(empty, { ...group, knownEnvironmentIds: ["gor"] }, []).chips,
    ).toEqual([]);
    expect(projectMachineStrip(empty, group, []).chips[0]?.environmentId).toBe("gor");
    expect(
      projectMachineStrip(
        { ...empty, machines: { gv: {} } },
        { ...group, knownEnvironmentIds: [] },
        [],
      ).chips,
    ).toHaveLength(1);
  });
  it("shows only scratch thread machines once, ignoring representations", () => {
    const config = { ...empty, projectMounts: { demo: [rep("vps", "replica")] } };
    const model = projectMachineStrip(
      config,
      { ...group, isScratch: true, environmentIds: ["gv", "gor", "gv"] },
      [],
    );
    expect(model.chips.map((chip) => chip.environmentId)).toEqual(["gv", "gor"]);
    expect(model.description).toBe("Scratch on gv · Scratch on gor");
  });
});
