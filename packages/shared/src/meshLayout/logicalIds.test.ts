import { expect, it } from "vite-plus/test";
import { keys, merge, canonical, type MeshLayoutDocument } from "./document.ts";
import { migrateLogicalProjectIds, opaqueProjectId } from "./logicalIds.ts";
import { materialize } from "./materialize.ts";

it("migrates legacy projects, titles, placements, folds and aliases with stable clocks and ids", () => {
  const old = "github.com/owner/repository",
    physical = "machine:/home/user/repository",
    id = opaqueProjectId(old);
  const h = "0000000000100.00000.machine";
  const rep = {
    environmentId: "machine",
    path: "/home/user/repository",
    projectId: "local",
    role: "primary",
    transport: "git",
    createdAt: "",
  };
  const raw: MeshLayoutDocument = {
    [keys.representation(old, "machine")]: { v: rep, h },
    [keys.projectTitle(old)]: { v: "Project title", h },
    [keys.alias(physical)]: { v: old, h },
    [keys.place(old, "ws")]: { v: { sort: "a0" }, h },
    [keys.fold("ws", old)]: { v: "quiet", h },
  };
  const migrated = migrateLogicalProjectIds(raw),
    config = materialize(migrated);
  expect(id).toMatch(/^lp-[a-f0-9]{64}$/);
  expect(config.projectAliases).toEqual({ [old]: id, [physical]: id });
  expect(config.projectMounts[id]).toEqual([{ ...rep, syncKey: old }]);
  expect(config.projectTitles[id]).toBe("Project title");
  expect(config.placements[id]).toEqual(["ws"]);
  expect(config.workspaceFold.ws?.[id]).toBe("quiet");
  expect(migrateLogicalProjectIds(migrated)).toEqual(migrated);
  const removed = {
    [keys.representation(id, "machine")]: { v: null, h: "0000000000200.00000.machine" },
  };
  const left = migrateLogicalProjectIds(merge(raw, removed)),
    right = migrateLogicalProjectIds(merge(removed, raw));
  expect(canonical(left)).toBe(canonical(right));
  expect(materialize(left).projectMounts[id]).toBeUndefined();
  expect(opaqueProjectId(id)).toBe(id);
  expect(opaqueProjectId("title:project")).not.toContain("title:");
});
