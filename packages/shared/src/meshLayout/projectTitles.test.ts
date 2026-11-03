import { expect, it } from "vite-plus/test";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG, SidebarWorkspacesConfig } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { diff, materialize, merge, keys } from "./index.ts";

const decodeConfig = Schema.decodeSync(SidebarWorkspacesConfig);

it("defaults old layouts and merges project renames independently of other entries", () => {
  const before = decodeConfig({});
  expect(before.projectTitles).toEqual({});
  const key = "github.com/acme/app";
  const legacy = { [keys.project(key)]: { v: { title: "Legacy" }, h: "0000000000000.00000.a" } };
  expect(materialize(legacy).projectTitles[key]).toBe("Legacy");
  const entries = diff(
    before,
    { ...before, projectTitles: { [key]: "New name" } },
    {},
    "0000000000001.00000.a",
  );
  expect(entries[keys.projectTitle(key)]?.v).toEqual("New name");
  const other = diff(
    before,
    { ...before, machines: { a: { label: "Machine" } } },
    {},
    "0000000000001.00000.b",
  );
  const combined = merge(entries, other);
  expect(materialize(combined).projectTitles[key]).toBe("New name");
  expect(materialize(combined).machines.a?.label).toBe("Machine");
  const renamed = { ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG, projectTitles: { [key]: "Newest" } };
  const next = merge(
    combined,
    diff(materialize(combined), renamed, combined, "0000000000002.00000.a"),
  );
  expect(materialize(next).projectTitles[key]).toBe("Newest");
  const removed = merge(next, diff(materialize(next), before, next, "0000000000003.00000.a"));
  expect(materialize(removed).projectTitles).toEqual({});
});
