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
    gvidon: { label: "Gvidon" },
  },
};

describe("machineDisplayOf", () => {
  it("uses the server label and its first two letters as the tag", () => {
    expect(machineDisplayOf(config, "gor", "gor")).toEqual({
      label: "gor",
      tag: "GO",
      color: workspaceColor({ id: "gor" }),
    });
  });

  it("takes digits as tag characters and skips other characters", () => {
    expect(machineDisplayOf(config, "a", "DESKTOP-ABC").tag).toBe("DE");
    expect(machineDisplayOf(config, "b", "3rd machine").tag).toBe("3R");
    expect(machineDisplayOf(config, "c", "— Operalia").tag).toBe("OP");
  });

  it("prefers the saved label, tag and colour", () => {
    const machine = machineDisplayOf(
      {
        machines: { gvidon: { label: "Home", tag: "hm1", color: "#123456" } },
      },
      "gvidon",
      "server label",
    );
    expect(machine).toEqual({ label: "Home", tag: "HM1", color: "#123456" });
  });

  it("falls back to the environment id when nothing names the machine", () => {
    expect(machineDisplayOf(config, "e2e6225c", "  ").label).toBe("e2e6225c");
    expect(machineDisplayOf(config, "e2e6225c", "").tag).toBe("E2");
  });

  it("derives the colour from the environment id like workspaces do", () => {
    expect(machineDisplayOf(config, "operatia", "x").color).toBe(
      workspaceColor({ id: "operatia" }),
    );
    expect(WORKSPACE_COLORS).toContain(machineDisplayOf(config, "operatia", "x").color);
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
    const next = setMachineDisplay(config, "gor", { label: " Gor ", tag: "gor1" });
    expect(next.machines.gor).toEqual({ label: "Gor", tag: "GOR" });
    expect(next.machines.gvidon).toEqual({ label: "Gvidon" });
    expect(config.machines.gor).toBeUndefined();
  });

  it("clears fields and removes an emptied machine", () => {
    const cleared = setMachineDisplay(config, "gvidon", { label: null });
    expect(cleared.machines.gvidon).toBeUndefined();
    expect(config.machines.gvidon).toEqual({ label: "Gvidon" });
  });

  it("keeps the fields a patch does not name", () => {
    const next = setMachineDisplay(config, "gvidon", { color: WORKSPACE_COLORS[3] });
    expect(next.machines.gvidon).toEqual({ label: "Gvidon", color: WORKSPACE_COLORS[3] });
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
