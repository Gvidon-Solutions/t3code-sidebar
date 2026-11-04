import { expect, it } from "@effect/vitest";
import { SidebarWorkspacesConfig } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import atlas from "../../../../client-runtime/src/state/meshLayout/fixtures/atlas.json" with { type: "json" };
import boreal from "../../../../client-runtime/src/state/meshLayout/fixtures/boreal.json" with { type: "json" };
import { adoptLegacy, importLegacy, materialize } from "../index.ts";

it.each([
  [atlas, boreal],
  [boreal, atlas],
])(
  "unifies legacy workspace names and keeps every placement in either join order",
  (first, second) => {
    const a = decodeConfig(first);
    const b = decodeConfig(second);
    const result = materialize(
      adoptLegacy(b, importLegacy(a, "first", "0000000000000.00000.first")),
    );
    expect(result.workspaces.filter((w) => w.name === "main")).toEqual([
      expect.objectContaining({ id: "main", name: "main" }),
    ]);
    for (const source of [a, b])
      for (const [project, placements] of Object.entries(source.placements)) {
        for (const id of placements) {
          const name = source.workspaces.find((w) => w.id === id)?.name;
          const target = result.workspaces.find((w) => w.name === name)?.id ?? id;
          expect(result.placements[project]).toContain(target);
        }
      }
  },
);

const decodeConfig = Schema.decodeUnknownSync(SidebarWorkspacesConfig);

it("adopts legacy into a workspace already edited by a peer without recreating its old id", () => {
  const a = decodeConfig(atlas);
  const b = decodeConfig(boreal);
  const existing = importLegacy(a, "peer", "0000000000100.00000.peer");
  const result = materialize(adoptLegacy(b, existing));
  expect(result.workspaces.filter((w) => w.name === "main")).toEqual([
    expect.objectContaining({ id: "workspace-4" }),
  ]);
  expect(Object.values(result.placements).flat()).not.toContain("main");
});

it("keeps both orders and folds when a received document already contains both legacy ids", () => {
  const before = decodeConfig({
    workspaces: [
      { id: "main", name: "main" },
      { id: "old-main", name: "main" },
    ],
    placements: { a: ["main"], b: ["old-main"] },
    workspaceProjectOrder: { main: ["a"], "old-main": ["b"] },
    workspaceFold: { main: { a: "quiet" }, "old-main": { b: "active" } },
  });
  const doc = importLegacy(before, "peer", "0000000000000.00000.peer");
  doc["ws/main"] = { ...doc["ws/main"]!, h: "0000000000100.00000.peer" };
  const result = materialize(adoptLegacy(decodeConfig({}), doc));
  expect(result.workspaces).toHaveLength(1);
  expect(result.workspaceProjectOrder.main).toEqual(expect.arrayContaining(["a", "b"]));
  expect(result.workspaceFold.main).toEqual({ a: "quiet", b: "active" });
  expect(result.placements).toEqual({ a: ["main"], b: ["main"] });
});

it("replicates user-defined machine aliases while decoding older machines without aliases", () => {
  const before = decodeConfig({
    machines: {
      local: {
        label: "Build",
        tag: "BLD",
        aliases: ["office", "研究室"],
        reach: { remote: { ssh: "customer@worker" } },
      },
      remote: { label: "Remote" },
    },
  });
  const result = materialize(importLegacy(before, "local", "0000000000100.00000.local"));
  expect(decodeConfig(result).machines).toEqual(before.machines);
  expect(result.machines.remote?.aliases).toBeUndefined();
});
