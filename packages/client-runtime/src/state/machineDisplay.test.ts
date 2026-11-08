import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  knownMachineIds,
  machineDisplayOf,
  machineTagBackground,
  normalizeMachineTag,
  setMachineDisplay,
  spansMultipleEnvironments,
} from "./machineDisplay.ts";
import { WORKSPACE_COLORS, workspaceColor } from "./sidebarWorkspaces.ts";

const config: SidebarWorkspacesConfig = {
  ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  machines: {
    atlas: { label: "Atlas" },
  },
};

describe("machineDisplayOf", () => {
  it("keeps short alphanumeric labels whole and abbreviates longer labels", () => {
    expect(machineDisplayOf(config, "lab-id", "lab")).toEqual({
      label: "lab",
      tag: "LAB",
      color: workspaceColor({ id: "lab-id" }),
    });
    for (const [label, tag] of [
      ["a", "A"],
      ["p2", "P2"],
      ["v-p-s", "VPS"],
      ["Лаб", "ЛАБ"],
      ["atlas", "AT"],
    ] as const) {
      expect(machineDisplayOf(config, "test", label).tag).toBe(tag);
    }
  });

  it("takes digits as tag characters and skips other characters", () => {
    expect(machineDisplayOf(config, "a", "DESKTOP-ABC").tag).toBe("DE");
    expect(machineDisplayOf(config, "b", "3rd machine").tag).toBe("3R");
    expect(machineDisplayOf(config, "c", "— Boreal").tag).toBe("BO");
  });

  it("prefers the saved label, tag and colour", () => {
    const machine = machineDisplayOf(
      {
        machines: { atlas: { label: "Home", tag: "hm1", color: "#123456" } },
      },
      "atlas",
      "server label",
    );
    expect(machine).toEqual({ label: "Home", tag: "HM1", color: "#123456" });
  });

  it("keeps unnamed machine ids out of display labels", () => {
    expect(machineDisplayOf(config, "e2e6225c", "  ").label).toBe("Unnamed machine");
    expect(machineDisplayOf(config, "e2e6225c", "").tag).toBe("");
    expect(machineDisplayOf(config, "e2e6225c", "   ").tag).toBe("");
  });

  it("derives the colour from the environment id like workspaces do", () => {
    expect(machineDisplayOf(config, "boreal", "x").color).toBe(workspaceColor({ id: "boreal" }));
    expect(WORKSPACE_COLORS).toContain(machineDisplayOf(config, "boreal", "x").color);
  });
});

describe("normalizeMachineTag", () => {
  it("trims, uppercases and limits to three graphemes", () => {
    expect(normalizeMachineTag("  ab ")).toBe("AB");
    expect(normalizeMachineTag("abcd")).toBe("ABC");
    expect(normalizeMachineTag("a b")).toBe("AB");
    expect(normalizeMachineTag("🙂🙂🙂🙂")).toBe("🙂🙂🙂");
  });

  it("returns null for an empty tag", () => {
    expect(normalizeMachineTag("   ")).toBeNull();
  });
});

describe("setMachineDisplay", () => {
  it("sets fields without touching the rest of the config", () => {
    const next = setMachineDisplay(config, "lab", { label: " Lab ", tag: "lab1" });
    expect(next.machines.lab).toEqual({ label: "Lab", tag: "LAB" });
    expect(next.machines.atlas).toEqual({ label: "Atlas" });
    expect(config.machines.lab).toBeUndefined();
  });

  it("clears fields and removes an emptied machine", () => {
    const cleared = setMachineDisplay(config, "atlas", { label: null });
    expect(cleared.machines.atlas).toBeUndefined();
    expect(config.machines.atlas).toEqual({ label: "Atlas" });
  });

  it("keeps the fields a patch does not name", () => {
    const next = setMachineDisplay(config, "atlas", { color: WORKSPACE_COLORS[3] });
    expect(next.machines.atlas).toEqual({ label: "Atlas", color: WORKSPACE_COLORS[3] });
    const aliased = setMachineDisplay(next, "atlas", {
      aliases: [" Office ", "office", "", "офис"],
    });
    expect(aliased.machines.atlas?.aliases).toEqual(["office", "офис"]);
    expect(setMachineDisplay(aliased, "atlas", { tag: "HQ" }).machines.atlas?.aliases).toEqual([
      "office",
      "офис",
    ]);
    expect(
      setMachineDisplay(aliased, "atlas", { aliases: [] }).machines.atlas?.aliases,
    ).toBeUndefined();
  });
});

describe("spansMultipleEnvironments", () => {
  it("is true only with two distinct environment ids", () => {
    expect(spansMultipleEnvironments([])).toBe(false);
    expect(spansMultipleEnvironments(["a", "a"])).toBe(false);
    expect(spansMultipleEnvironments(["a", "b"])).toBe(true);
  });
});

describe("knownMachineIds", () => {
  it("adds connected ids, saved machines, mounts and replica statuses", () => {
    const layout: SidebarWorkspacesConfig = {
      ...config,
      machines: { saved: {} },
      projectMounts: {
        project: [
          {
            environmentId: "mount",
            path: "/p",
            transport: "mutagen",
            role: "replica",
            source: "source",
            createdAt: "",
          },
        ],
      },
      projectMountStatus: { project: { status: { state: "watching", updatedAt: "" } } },
    };
    expect(knownMachineIds(layout, ["connected", "saved"])).toEqual([
      "connected",
      "mount",
      "saved",
      "source",
      "status",
    ]);
  });
});

describe("machineTagBackground", () => {
  it("tints six- and three-digit hex colors", () => {
    expect(machineTagBackground("#6d8cff")).toBe("rgba(109, 140, 255, 0.14)");
    expect(machineTagBackground("#fff", 0.2)).toBe("rgba(255, 255, 255, 0.2)");
  });
  it("falls back to a neutral tint for other colors", () => {
    expect(machineTagBackground("rebeccapurple")).toBe("rgba(128, 128, 128, 0.14)");
    expect(machineTagBackground("rgb(1, 2, 3)")).toBe("rgba(128, 128, 128, 0.14)");
  });
});
