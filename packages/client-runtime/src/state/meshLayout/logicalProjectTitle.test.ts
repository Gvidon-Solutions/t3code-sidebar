import { expect, it } from "vite-plus/test";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG as empty } from "@t3tools/contracts";
import { logicalProjectTitle } from "./logicalProjects.ts";
import { diff, materialize, merge } from "@t3tools/shared/meshLayout";

it("reads legacy title keys through aliases and writes the separate title family on rename", () => {
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
  expect(Object.keys(edit)).toEqual(["projTitle/opaque"]);
  expect(logicalProjectTitle(materialize(merge({}, edit)), "opaque", "local")).toBe("Renamed");
  expect(logicalProjectTitle(empty, "github.com/owner/repo", "Project")).toBe("Project");
});
