import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import * as NodeFS from "node:fs";
const fs = NodeFS;
import * as NodeOS from "node:os";
const os = NodeOS;
import * as NodePath from "node:path";
const path = NodePath;
import * as NodeChildProcess from "node:child_process";
const { spawnSync } = NodeChildProcess;
test("stages a generic skill without personal registry data; refuses legacy fleet installation", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "b1-kit-staging-"));
  try {
    const destination = path.join(home, "staged skill");
    const script = new URL("install.mjs", import.meta.url).pathname;
    const staged = spawnSync(process.execPath, [script, "--dest", destination], {
      encoding: "utf8",
    });
    assert.equal(staged.status, 0, staged.stderr);
    assert.ok(fs.existsSync(path.join(destination, "SKILL.md")));
    assert.ok(fs.existsSync(path.join(destination, "scripts/t3ctl.mjs")));
    assert.ok(!fs.existsSync(path.join(destination, "global")));
    assert.ok(!fs.existsSync(path.join(destination, "scripts/t3ctl.unit.test.mjs")));
    const rejected = spawnSync(process.execPath, [script, "--apply"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Servers install and reconcile/);
    assert.ok(!fs.existsSync(path.join(home, ".codex")));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
