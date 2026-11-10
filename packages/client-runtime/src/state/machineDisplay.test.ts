import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  environmentNameOf,
  knownMachineIds,
  machineDisplayOf,
  machineTagBackground,
  machineTagPalette,
  normalizeMachineTag,
  relativeLuminance,
  resolveMachineTagAppearance,
  setMachineDisplay,
  spansMultipleEnvironments,
  type ResolvedMachineTagAppearance,
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

describe("environmentNameOf", () => {
  it("names three mesh machines that share one OS host name by their config tag and title", () => {
    const mesh: SidebarWorkspacesConfig = {
      ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
      machines: {
        "env-studio": { title: "studio", tag: "ST" },
        "env-cloudbox": { title: "cloudbox", tag: "CB" },
        "env-laptop": { title: "laptop", tag: "LT" },
      },
    };
    const names = ["env-studio", "env-cloudbox", "env-laptop"].map((environmentId) =>
      environmentNameOf(mesh, environmentId, "shared-host"),
    );
    expect(names.map((name) => [name.tag, name.label])).toEqual([
      ["ST", "studio"],
      ["CB", "cloudbox"],
      ["LT", "laptop"],
    ]);
    expect(names.every((name) => name.inMesh)).toBe(true);
    expect(new Set(names.map((name) => name.label)).size).toBe(3);
  });

  it("keeps the host name for an environment outside any mesh", () => {
    expect(environmentNameOf(null, "env-1", "shared-host")).toEqual({
      label: "shared-host",
      tag: "",
      color: workspaceColor({ id: "env-1" }),
      inMesh: false,
    });
    expect(environmentNameOf({ machines: {} }, "env-1", "shared-host")).toMatchObject({
      label: "shared-host",
      tag: "",
      inMesh: false,
    });
  });

  it("keeps the host name for an environment the config does not name", () => {
    expect(
      environmentNameOf(
        { machines: { other: { title: "studio", tag: "ST" } } },
        "env-1",
        "shared-host",
      ),
    ).toMatchObject({ label: "shared-host", tag: "", inMesh: false });
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

const hexRgb = (color: string) => {
  const hex = color.replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((part) => part + part).join("") : hex;
  const value = Number.parseInt(full, 16);
  return { red: (value >> 16) & 255, green: (value >> 8) & 255, blue: value & 255 };
};
const contrast = (
  foreground: { readonly red: number; readonly green: number; readonly blue: number },
  background: { readonly red: number; readonly green: number; readonly blue: number },
) => {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
};
const tintOver = (machine: string, base: string) => {
  const color = hexRgb(machine);
  const backdrop = hexRgb(base);
  const mix = (channel: number, over: number) => channel * 0.14 + over * 0.86;
  return {
    red: mix(color.red, backdrop.red),
    green: mix(color.green, backdrop.green),
    blue: mix(color.blue, backdrop.blue),
  };
};

describe("machine tag appearance", () => {
  it("defaults to the tinted machine-coloured look for every client", () => {
    expect(resolveMachineTagAppearance(undefined)).toEqual({
      style: "tinted",
      textColor: "machine",
    });
    expect(
      resolveMachineTagAppearance({
        ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
        appearance: { machineTags: { style: "outline", textColor: "neutral" } },
      }),
    ).toEqual({ style: "outline", textColor: "neutral" });
    expect(
      resolveMachineTagAppearance({
        ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
        appearance: {
          machineTags: {
            style: "unknown",
            textColor: "unknown",
          } as unknown as ResolvedMachineTagAppearance,
        },
      }),
    ).toEqual({ style: "tinted", textColor: "machine" });
  });

  it("draws tinted, solid and outline tags with readable text in both themes", () => {
    const colors = ["#ffffff", "#000000", "#6d8cff", "#e0795b", "#d9a640"];
    for (const theme of ["light", "dark"] as const) {
      for (const color of colors) {
        const tinted = machineTagPalette(color, { style: "tinted", textColor: "machine" }, theme);
        expect(tinted.backgroundColor).toBe(machineTagBackground(color));
        expect(tinted.borderColor).toBeUndefined();
        expect(tinted.color).toBeDefined();
        expect(
          contrast(
            hexRgb(tinted.color!),
            tintOver(color, theme === "light" ? "#ffffff" : "#0f0f0f"),
          ),
        ).toBeGreaterThanOrEqual(3);

        const neutral = machineTagPalette(color, { style: "tinted", textColor: "neutral" }, theme);
        expect(neutral.color).toBeUndefined();

        const solid = machineTagPalette(color, { style: "solid", textColor: "machine" }, theme);
        expect(solid.backgroundColor).toBe(color);
        expect(solid.borderColor).toBeUndefined();
        expect(contrast(hexRgb(solid.color!), hexRgb(color))).toBeGreaterThanOrEqual(4.5);

        const outline = machineTagPalette(color, { style: "outline", textColor: "machine" }, theme);
        expect(outline.backgroundColor).toBeUndefined();
        expect(outline.borderColor).toBe(outline.color);
        expect(
          contrast(hexRgb(outline.color!), hexRgb(theme === "light" ? "#ffffff" : "#0f0f0f")),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the hue while moving only lightness and falls back for unknown colours", () => {
    const pale = machineTagPalette("#ffffff", { style: "tinted", textColor: "machine" }, "light");
    const dark = machineTagPalette("#ffffff", { style: "tinted", textColor: "machine" }, "dark");
    expect(relativeLuminance(hexRgb(pale.color!))).toBeLessThanOrEqual(0.19);
    expect(dark.color).toBe("#ffffff");
    const unknown = machineTagPalette(
      "rebeccapurple",
      { style: "tinted", textColor: "machine" },
      "light",
    );
    expect(unknown.backgroundColor).toBe("rgba(128, 128, 128, 0.14)");
    expect(unknown.color).toBeDefined();
  });
});
