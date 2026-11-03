import { expect, it } from "vite-plus/test";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG as empty } from "@t3tools/contracts";
import { logicalProjectTitle } from "./logicalProjects.ts";
import { diff, materialize, merge } from "@t3tools/shared/meshLayout";

it("reads the coordinator's exact title key through aliases and preserves the id when renamed", () => {
  const original = materialize({
    "alias/legacy": { v: "opaque", h: "0000000000001.00000.a" },
    "proj/opaque.title": { v: "Shared title", h: "0000000000001.00000.a" },
  });
  expect(logicalProjectTitle(original, "legacy", "local title")).toBe("Shared title");
  const edit = diff(
    original,
    { ...original, projectTitles: { opaque: "Renamed" } },
    {},
    "0000000000002.00000.b",
  );
  expect(Object.keys(edit)).toEqual(["proj/opaque.title"]);
  expect(logicalProjectTitle(materialize(merge({}, edit)), "opaque", "local")).toBe("Renamed");
  expect(logicalProjectTitle(empty, "github.com/owner/repo", "Project")).toBe("Project");
});
