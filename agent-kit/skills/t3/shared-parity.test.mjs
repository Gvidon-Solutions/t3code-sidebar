import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import {
  encode,
  receive,
  adoptLegacy,
  materialize,
  importLegacy,
} from "../../../packages/shared/src/meshLayout/index.ts";
import { encodeLegacyEntries, importLegacyEntries } from "./scripts/t3ctl.mjs";
const empty = {
  workspaces: [],
  assignments: {},
  placements: {},
  rules: [],
  defaultWorkspace: null,
  projectOrder: [],
  workspaceProjectOrder: {},
  workspaceFold: {},
  quietAfterDays: 5,
  alwaysShow: [],
  alwaysQuiet: [],
  machines: {},
  projectAliases: {},
  projectMounts: {},
  projectMountStatus: {},
};
test("standalone encoder agrees with shared core and clocks can be received", () => {
  for (const config of [
    empty,
    {
      ...empty,
      workspaces: [{ id: "z", name: "Main" }],
      placements: { "offline:/path": ["z"] },
      machines: { offline: { label: "Offline" } },
      projectMounts: { x: [] },
    },
  ]) {
    assert.deepEqual(encodeLegacyEntries(config), encode(config));
    for (const e of Object.values(importLegacyEntries(config, "source")))
      assert.doesNotThrow(() => receive("0000000000001.00000.local", e.h, 2));
  }
});
test("zero-clock legacy entries use server shared adoption without losing offline keys", () => {
  const first = { ...empty, workspaces: [{ id: "a", name: "Main" }] };
  const second = {
    ...empty,
    workspaces: [{ id: "z", name: "Main" }],
    placements: { "offline:/path": ["z"] },
  };
  const existing = importLegacy(first, "local", "0000000000000.00000.local");
  const result = adoptLegacy(empty, { ...existing, ...importLegacyEntries(second, "remote") });
  const config = materialize(result);
  assert.equal(config.workspaces.length, 1);
  assert.deepEqual(config.placements["offline:/path"], ["a"]);
});
