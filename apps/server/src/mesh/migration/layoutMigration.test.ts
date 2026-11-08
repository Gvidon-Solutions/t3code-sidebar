import { expect, it } from "vite-plus/test";
import { importLegacy, materialize, merge } from "@t3tools/shared/meshLayout";
import { migrateLayout, legacySettingsDiff } from "./layoutMigration.ts";
it("migrates once by value and preserves concurrent fields when an old client edits settings", () => {
  const legacy = {
    ...materialize({}),
    workspaces: [{ id: "old", name: "Main" }],
    meshAuthority: "studio",
  };
  const oldEntry = { v: "studio", h: "0000000000000.00000.legacy" };
  const migrated = migrateLayout({
    ...importLegacy(legacy, "studio", "0000000000000.00000.legacy"),
    "mesh.authority": oldEntry,
  });
  expect(migrateLayout(migrated)).toEqual(migrated);
  expect(migrated["mesh.authority"]).toEqual(oldEntry);
  expect(materialize(migrated)).not.toHaveProperty("meshAuthority");
  const concurrent = merge(migrated, {
    "proj/example.title": { v: "Shared", h: "0000000000001.00000.cloudbox" },
    "repstatus/example/studio": {
      v: { state: "paused", updatedAt: "", resolvingConflicts: "owned-session" },
      h: "0000000000001.00000.studio",
    },
  });
  const before = materialize(concurrent);
  const legacyUpdate = {
    ...before,
    projectTitles: {},
    projectMountStatus: { example: { studio: { state: "watching" as const, updatedAt: "" } } },
    quietAfterDays: 11,
    meshAuthority: "laptop",
  };
  const delta = legacySettingsDiff(before, legacyUpdate, concurrent, "0000000000002.00000.studio");
  expect(Object.keys(delta)).toEqual(["ws.quietAfterDays"]);
  const result = materialize(merge(concurrent, delta));
  expect(result.projectTitles.example).toBe("Shared");
  expect(result.projectMountStatus.example?.studio).toMatchObject({
    state: "paused",
    resolvingConflicts: "owned-session",
  });
});
