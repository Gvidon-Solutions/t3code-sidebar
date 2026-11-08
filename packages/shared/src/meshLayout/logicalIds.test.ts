import { logicalProjectKeyForRecord } from "./projectRecord.ts";
import { expect, it } from "vite-plus/test";
import { keys, merge, canonical, type MeshLayoutDocument } from "./document.ts";
import { migrateLogicalProjectIds, opaqueProjectId } from "./logicalIds.ts";
import { materialize } from "./materialize.ts";

it("migrates legacy projects, titles, placements, folds and aliases with stable clocks and ids", () => {
  const old = "title:repository",
    physical = "machine:/checkout/repository",
    id = opaqueProjectId(old);
  const h = "0000000000100.00000.machine";
  const rep = {
    environmentId: "machine",
    path: "/checkout/repository",
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
  expect(opaqueProjectId("a.b/c")).toBe("a.b/c");
  expect(opaqueProjectId("title:project")).not.toContain("title:");
});

it("binds unmounted legacy records through aliases while explicit representations win", () => {
  let config: ReturnType<typeof materialize> = {
    ...materialize({}),
    projectAliases: {
      "title:example project": "intermediate",
      intermediate: "title-project",
      "github.com/acme/repo": "repository-project",
      "machine:/project": "physical-project",
    },
  };
  const record = { environmentId: "machine", workspaceRoot: "/other", title: " Example  Project " };
  expect(logicalProjectKeyForRecord(config, record, "new-id")).toBe("title-project");
  const repo = {
    ...record,
    repositoryIdentity: {
      canonicalKey: "local-repo",
      origin: { canonicalKey: "github.com/acme/repo" },
    },
  };
  expect(logicalProjectKeyForRecord(config, repo, "new-id")).toBe("repository-project");
  expect(
    logicalProjectKeyForRecord(config, { ...repo, workspaceRoot: "/project/./" }, "new-id"),
  ).toBe("physical-project");
  config = {
    ...config,
    projectMounts: {
      ...config.projectMounts,
      explicit: [
        {
          environmentId: "machine",
          path: "/project",
          role: "primary",
          transport: "git",
          createdAt: "",
        },
      ],
    },
  };
  expect(logicalProjectKeyForRecord(config, { ...repo, workspaceRoot: "/project" }, "new-id")).toBe(
    "explicit",
  );
  config = {
    ...config,
    projectAliases: { ...config.projectAliases, intermediate: "title:example project" },
  };
  expect(logicalProjectKeyForRecord(config, record, "new-id")).toBe("intermediate");
  expect(logicalProjectKeyForRecord(config, { ...record, title: "Unrelated" }, "new-id")).toBe(
    "new-id",
  );
});
