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
const empty = materialize({});

test("standalone encoder agrees with shared core and clocks can be received", () => {
  for (const config of [
    empty,
    {
      ...empty,
      workspaces: [{ id: "z", name: "Main" }],
      placements: { "offline:/path": ["z"] },
      machines: { offline: { label: "Offline" } },
      projectMounts: { x: [] },
      projectTitles: { x: "Shared project title" },
      projectAliases: { "legacy:/path": "x" },
      projectMountStatus: {
        x: {
          offline: {
            state: "watching",
            updatedAt: "",
            skipped: 1,
            skippedPaths: [{ path: "outside", error: "invalid symlink" }],
          },
        },
      },
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

test("alias writes match bounded shared clocks, including counter overflow", async () => {
  const { nextMachineClock } = await import("./scripts/t3ctl.mjs");
  const { tick } = await import("../../../packages/shared/src/meshLayout/index.ts");
  for (const last of [
    null,
    "0000000000042.99999.peer",
    "0000000300042.99999.peer",
    "0000000000000.99999.peer",
    "0000000300000.99999.peer",
    "9999999999998.00042.peer",
    "9999999999998.99999.peer",
  ]) {
    const document = last
      ? { "machine/remote": { v: { aliases: ["office", "研究室"] }, h: last } }
      : {};
    for (const now of [0, 42, 42.8])
      assert.equal(nextMachineClock(document, now, "client"), tick(now, last, "client"));
  }
  const config = {
    ...empty,
    machines: {
      remote: {
        label: "Worker",
        aliases: ["office", "研究室"],
        reach: { local: { ssh: "user@node" } },
      },
    },
  };
  const imported = importLegacyEntries(config, "local");
  assert.deepEqual(imported["machine/remote"].v.reach, config.machines.remote.reach);
  assert.deepEqual(
    { ...materialize(imported).machines },
    { remote: { label: "Worker", aliases: ["office", "研究室"] } },
  );
});
