import { describe, it, expect } from "vite-plus/test";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG as empty,
  SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  addWorkspace,
  updateWorkspace,
  deleteWorkspace,
  reorderWorkspaces,
  setProjectWorkspaces,
  toggleProjectWorkspace,
  dropProjectOnWorkspace,
  moveProjectInWorkspace,
  setProjectFoldMode,
} from "../sidebarWorkspaces.ts";
import { buildProjectGroups } from "../projectGrouping.ts";
import { tick, receive, compare } from "./index.ts";
import { between, generateN } from "./index.ts";
import { merge, apply, keys, entriesNewerThan, type MeshLayoutDocument } from "./index.ts";
import { diff } from "./index.ts";
import { materialize } from "./index.ts";
import { importLegacy, mergeLegacyConfigs } from "./index.ts";
import * as logical from "./logicalProjects.ts";
import gvidon from "./fixtures/gvidon.json" with { type: "json" };
import operalia from "./fixtures/operalia.json" with { type: "json" };

const decodeConfig = Schema.decodeUnknownSync(SidebarWorkspacesConfig);
const low = "0000000000000.00000.seed";
const config: SidebarWorkspacesConfig = {
  ...empty,
  workspaces: [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ],
  defaultWorkspace: "a",
  projectOrder: ["p", "q", "r"],
  placements: { p: ["a", "b"], q: ["a"] },
  assignments: { p: "a", q: "a" },
  workspaceProjectOrder: { a: ["p", "q"] },
};
const project = { projectKey: "p", workspaceRoots: ["/p"] };
function rng(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
const rep = (environmentId: string): SidebarWorkspacesConfig["projectMounts"][string][number] => ({
  environmentId,
  path: "/p",
  transport: "git",
  role: "primary",
  createdAt: "",
});

describe("mesh clocks and ordering", () => {
  it("keeps HLC monotone with skew, receive, counter overflow and environment ties", () => {
    let h = tick(100, null, "a");
    for (let i = 0; i < 1000; i++) {
      const next = tick(i % 3, h, "a");
      expect(compare(next, h)).toBe(1);
      h = next;
    }
    const remote = tick(5000, null, "z");
    expect(receive(h, remote, 1) > remote).toBe(true);
    expect(receive(remote, remote, 0)).toBe("0000000005000.00001.z");
    expect(tick(1, "0000000005000.99999.a", "a")).toBe("0000000005001.00000.a");
    expect(compare(h, h)).toBe(0);
    expect(() => tick(1, "broken", "a")).toThrow();
  });
  it("generates short stable base62 keys under random insertions", () => {
    const random = rng(21),
      indices: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const at = Math.floor(random() * (indices.length + 1));
      const key = between(indices[at - 1] ?? null, indices[at] ?? null);
      indices.splice(at, 0, key);
    }
    expect([...indices].sort()).toEqual(indices);
    expect(new Set(indices).size).toBe(indices.length);
    expect(Math.max(...indices.map((k) => k.length))).toBeLessThan(12);
    const batch = generateN(null, null, 500);
    expect(batch).toEqual([...batch].sort());
    expect(batch).toEqual(generateN(null, null, 500));
    expect(() => between("A", "A")).toThrow();
    expect(() => between(null, "0")).toThrow();
  });
});
describe("LWW document", () => {
  it("obeys all merge laws and converges after 600 seeded three-replica concurrent sequences", () => {
    const random = rng(1017);
    for (let trial = 0; trial < 600; trial++) {
      const replicas: MeshLayoutDocument[] = [{}, {}, {}];
      const clocks = [low, low, low];
      for (let op = 0; op < 30; op++) {
        const i = Math.floor(random() * 3),
          key = `order/${Math.floor(random() * 8)}`;
        clocks[i] = tick(Math.floor(random() * 100), clocks[i]!, String(i));
        replicas[i] = apply(replicas[i]!, {
          [key]: { v: random() < 0.3 ? null : { sort: between(null, null) }, h: clocks[i]! },
        });
        if (random() < 0.2) {
          const j = (i + 1) % 3;
          replicas[j] = merge(replicas[j]!, replicas[i]!);
          clocks[j] = receive(clocks[j]!, clocks[i]!, 0);
        }
      }
      const [a, b, c] = replicas as [MeshLayoutDocument, MeshLayoutDocument, MeshLayoutDocument];
      expect(merge(a, b)).toEqual(merge(b, a));
      expect(merge(a, a)).toEqual(a);
      const expected = merge(merge(a, b), c);
      expect(expected).toEqual(merge(a, merge(b, c)));
      for (const replica of replicas)
        expect(merge(replica, merge(c, merge(b, a)))).toEqual(expected);
    }
    const a = { k: { v: "a", h: low } },
      b = { k: { v: null, h: low } };
    expect(merge(a, b)).toEqual(merge(b, a));
    expect(entriesNewerThan(a, low)).toEqual({});
    expect(entriesNewerThan(a, "0000000000000.00000.a")).toEqual(a);
  });
  it("escapes every key component, including slashes and percent signs", () => {
    const p = "github.com/a/b%",
      ws = "x/y";
    const doc = importLegacy(
      {
        ...empty,
        workspaces: [{ id: ws, name: "X" }],
        placements: { [p]: [ws] },
        assignments: { [p]: ws },
      },
      "a",
      low,
    );
    expect(materialize(doc).placements).toEqual({ [p]: [ws] });
    expect(keys.place(p, ws)).toContain("%2F");
  });
});
describe("materialization and diffs", () => {
  it("round trips every workspace edit and machine, alias, representation and status changes", () => {
    const doc = importLegacy(config, "a", low),
      before = materialize(doc),
      h = tick(1, low, "a");
    const operations: ((c: SidebarWorkspacesConfig) => SidebarWorkspacesConfig)[] = [
      (c) => addWorkspace(c).config,
      (c) => updateWorkspace(c, "b", { name: "Renamed", icon: "XY", color: "red" }),
      (c) => deleteWorkspace(c, "b"),
      (c) => ({ ...c, workspaces: reorderWorkspaces(c.workspaces, "c", 0) }),
      (c) => setProjectWorkspaces(c, project, ["c"]),
      (c) => toggleProjectWorkspace(c, project, "c"),
      (c) =>
        dropProjectOnWorkspace(c, project, {
          fromWorkspaceId: "a",
          toWorkspaceId: "c",
          add: false,
        }),
      (c) => moveProjectInWorkspace(c, "b", ["p", "q"], "p", null),
      (c) => setProjectFoldMode(c, "b", "p", "quiet"),
      (c) => setProjectFoldMode(c, "b", "p", "active"),
      (c) => setProjectFoldMode(c, "b", "p", "auto"),
      (c) => ({ ...c, machines: { a: { label: "A", reach: { b: { ssh: "b" } } } } }),
      (c) => ({ ...c, projectAliases: { p: "logical" } }),
      (c) => logical.addRepresentation(c, "p", rep("a")),
      (c) => ({ ...c, projectMountStatus: { p: { a: { state: "watching", updatedAt: "" } } } }),
      (c) => ({
        ...c,
        rules: [{ match: "/p/**", workspace: "b" }],
        quietAfterDays: 10,
        projectOrder: ["q", "r", "p"],
      }),
      (c) => ({ ...c, workspaceProjectOrder: { ...c.workspaceProjectOrder, c: [] } }),
    ];
    for (const edit of operations) {
      const after = edit(before);
      expect(materialize(apply(doc, diff(before, after, doc, h)))).toEqual(after);
    }
    expect(diff(before, before, doc, h)).toEqual({});
    const added = addWorkspace(materialize({})).config;
    expect(Object.keys(diff(materialize({}), added, {}, h))).toHaveLength(1);
    const moved = { ...before, workspaces: reorderWorkspaces(before.workspaces, "c", 0) };
    expect(Object.keys(diff(before, moved, doc, h))).toEqual([keys.workspace("c")]);
    const deleted = diff(before, deleteWorkspace(before, "b"), doc, h);
    expect(deleted[keys.workspace("b")]?.v).toBeNull();
  });
  it("round trips 600 seeded sequences of edits including deletion and implicit placements", () => {
    const random = rng(42);
    for (let trial = 0; trial < 600; trial++) {
      let doc = importLegacy(config, "a", low),
        h = low;
      for (let i = 0; i < 12; i++) {
        const before = materialize(doc),
          ws = before.workspaces[Math.floor(random() * before.workspaces.length)]!.id;
        const choice = Math.floor(random() * 6);
        const after =
          choice === 0
            ? addWorkspace(before).config
            : choice === 1
              ? deleteWorkspace(before, ws)
              : choice === 2
                ? toggleProjectWorkspace(before, project, ws)
                : choice === 3
                  ? moveProjectInWorkspace(before, ws, ["p", "q"], "q", random() < 0.5 ? "p" : null)
                  : choice === 4
                    ? setProjectFoldMode(before, ws, "p", random() < 0.5 ? "auto" : "quiet")
                    : { ...before, workspaces: reorderWorkspaces(before.workspaces, ws, 0) };
        h = tick(1, h, "a");
        doc = apply(doc, diff(before, after, doc, h));
        expect(materialize(doc)).toEqual(after);
      }
    }
  });
});
describe("concurrent layout edits", () => {
  it("converges across 500 three-machine edit histories and remains editable after sort collisions", () => {
    const random = rng(17);
    for (let trial = 0; trial < 500; trial++) {
      const initial = importLegacy(config, "seed", low);
      const replicas = [initial, initial, initial];
      for (let machine = 0; machine < 3; machine++) {
        let clock = low;
        for (let op = 0; op < 5; op++) {
          const doc = replicas[machine]!,
            before = materialize(doc);
          const ws = before.workspaces[Math.floor(random() * 3)]!.id;
          const after =
            random() < 0.5
              ? {
                  ...before,
                  workspaces: reorderWorkspaces(before.workspaces, ws, Math.floor(random() * 4)),
                }
              : setProjectFoldMode(before, ws, "p", random() < 0.5 ? "quiet" : "active");
          clock = tick(1, clock, String(machine));
          replicas[machine] = apply(doc, diff(before, after, doc, clock));
        }
      }
      const [a, b, c] = replicas as [MeshLayoutDocument, MeshLayoutDocument, MeshLayoutDocument];
      const doc = merge(a, merge(b, c));
      expect(doc).toEqual(merge(c, merge(a, b)));
      const before = materialize(doc),
        after = { ...before, workspaces: [...before.workspaces].reverse() };
      expect(materialize(apply(doc, diff(before, after, doc, tick(100, null, "new"))))).toEqual(
        after,
      );
    }
  });
});
describe("collection removals", () => {
  it("preserves reach through contracts and tombstones machine, alias, mount and status removals", () => {
    const before = decodeConfig({
      ...config,
      machines: { a: { label: "A", reach: { b: { ssh: "user@b" } } } },
      projectAliases: { old: "p" },
      projectMounts: { p: [rep("a")] },
      projectMountStatus: { p: { a: { state: "error", updatedAt: "" } } },
    });
    expect(before.machines.a?.reach?.b?.ssh).toBe("user@b");
    const doc = importLegacy(before, "a", low);
    const after = {
      ...before,
      machines: {},
      projectAliases: {},
      projectMounts: {},
      projectMountStatus: {},
    };
    const entries = diff(before, after, doc, tick(1, low, "a"));
    expect(Object.values(entries).every((e) => e.v === null)).toBe(true);
    expect(Object.keys(entries)).toHaveLength(4);
    expect(materialize(apply(doc, entries))).toEqual(after);
  });
});
describe("legacy configs", () => {
  it("imports both sanitized real server fixtures without pruning offline project keys and unifies main", () => {
    const configs = [gvidon, operalia].map((c) => decodeConfig(c));
    const sources = configs.map((config, i) => ({ config, envId: String(i) }));
    const merged = mergeLegacyConfigs(sources, low);
    expect(mergeLegacyConfigs([...sources].reverse(), low)).toEqual(merged);
    expect(merged.workspaces.filter((w) => w.name === "main").map((w) => w.id)).toEqual(["main"]);
    expect(merged.workspaces.some((w) => w.id === "workspace-4")).toBe(false);
    for (const c of configs) {
      const own = materialize(importLegacy(c, "a", low));
      for (const p of Object.keys(c.assignments)) expect(own.assignments).toHaveProperty(p);
      for (const p of new Set([...Object.keys(c.assignments), ...Object.keys(c.placements)]))
        expect(merged.placements[p]?.length).toBeGreaterThan(0);
      for (const p of c.projectOrder) expect(merged.projectOrder).toContain(p);
      for (const order of Object.values(c.workspaceProjectOrder))
        for (const p of order)
          expect(Object.values(merged.workspaceProjectOrder).flat()).toContain(p);
    }
  });
});
describe("logical projects", () => {
  it("resolves representations, physical aliases, cycles and the eight-hop bound", () => {
    const c = logical.addRepresentation(
      { ...empty, projectAliases: { logical: "final" } },
      "logical",
      rep("a"),
    );
    expect(
      logical.resolveLogicalProjectKey(
        { environmentId: "a", workspaceRoot: "/p/" },
        c,
        () => "fallback",
      ),
    ).toBe("final");
    expect(
      logical.resolveLogicalProjectKey(
        { environmentId: "b", workspaceRoot: "/p" },
        c,
        () => "fallback",
      ),
    ).toBe("fallback");
    const cycle = { ...empty, projectAliases: { a: "b", b: "a" } };
    expect(
      logical.resolveLogicalProjectKey(
        { environmentId: "x", workspaceRoot: "/" },
        cycle,
        () => "a",
      ),
    ).toBe("a");
    const aliases = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [String(i), String(i + 1)]),
    );
    expect(
      logical.resolveLogicalProjectKey(
        { environmentId: "x", workspaceRoot: "/" },
        { ...empty, projectAliases: aliases },
        () => "0",
      ),
    ).toBe("8");
  });
  it("merges references, splits representations, promotes and removes without mutating inputs", () => {
    let c = logical.addRepresentation(logical.addRepresentation(config, "p", rep("a")), "q", {
      ...rep("b"),
      role: "replica",
      source: "a",
    });
    c = {
      ...c,
      workspaceFold: { a: { p: "quiet" } },
      projectMountStatus: { q: { b: { state: "watching", updatedAt: "" } } },
    };
    const merged = logical.mergeLogicalProjects(c, "q", "p");
    expect(merged.projectAliases.q).toBe("p");
    expect(merged.projectOrder).toEqual(["p", "r"]);
    expect(merged.projectMounts.p).toHaveLength(2);
    expect(c.projectMounts.q).toHaveLength(1);
    const split = logical.splitLogicalProject(merged, "p", "b", "separate");
    expect(split.projectMounts.separate).toHaveLength(1);
    expect(split.projectMountStatus.separate?.b?.state).toBe("watching");
    expect(logical.setPrimary(split, "separate", "b").projectMounts.separate?.[0]).toMatchObject({
      role: "primary",
    });
    expect(
      logical.setPrimary(split, "separate", "b").projectMounts.separate?.[0],
    ).not.toHaveProperty("source");
    expect(
      logical.removeRepresentation(split, "separate", "b").projectMounts.separate,
    ).toBeUndefined();
    expect(logical.mergeLogicalProjects(c, "p", "p")).toBe(c);
    const suggestions = logical.suggestMerges([
      { environmentId: "a", workspaceRoot: "/p", title: " Project " },
      { environmentId: "b", workspaceRoot: "/q", title: "project" },
    ]);
    expect(suggestions).toHaveLength(1);
    expect(
      buildProjectGroups({
        projects: [],
        settings: { sidebarProjectGroupingMode: "separate", sidebarProjectGroupingOverrides: {} },
        layout: merged,
      }),
    ).toEqual([]);
    let doc = importLegacy(materialize(importLegacy(c, "a", low)), "a", low);
    let clock = low;
    for (const after of [merged, split, logical.removeRepresentation(split, "separate", "b")]) {
      const before = materialize(doc);
      doc = apply(doc, diff(before, after, doc, (clock = tick(2, clock, "z"))));
      expect(materialize(doc)).toEqual(after);
    }
  });
});
