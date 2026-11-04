import { expect, it } from "vite-plus/test";
import { importLegacy, materialize, merge } from "@t3tools/shared/meshLayout";
import { migrateLayout, legacySettingsDiff } from "./layoutMigration.ts";
it("migrates once by value and preserves concurrent fields when an old client edits settings", () => {
  const legacy = { ...materialize({}), workspaces: [{ id: "old", name: "Main" }] };
  const migrated = migrateLayout(importLegacy(legacy, "studio", "0000000000000.00000.legacy"));
  expect(migrateLayout(migrated)).toEqual(migrated);
  const concurrent = merge(migrated, {
    "proj/example.title": { v: "Shared", h: "0000000000001.00000.cloudbox" },
  });
  const before = materialize(concurrent);
  const delta = legacySettingsDiff(
    before,
    { ...before, projectTitles: {}, quietAfterDays: 11 },
    concurrent,
    "0000000000002.00000.studio",
  );
  expect(Object.keys(delta)).toEqual(["ws.quietAfterDays"]);
  expect(materialize(merge(concurrent, delta)).projectTitles.example).toBe("Shared");
});
