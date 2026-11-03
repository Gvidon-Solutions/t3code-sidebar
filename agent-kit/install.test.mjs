import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import * as NodeChildProcess from "node:child_process";
const { spawnSync } = NodeChildProcess;
import * as NodeFS from "node:fs";
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } =
  NodeFS;
import * as NodeOS from "node:os";
const { tmpdir, hostname } = NodeOS;
import * as NodePath from "node:path";
const { join } = NodePath;

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "t3-kit-"));
  mkdirSync(join(home, ".agents/skills/t3"), { recursive: true });
  writeFileSync(join(home, ".agents/skills/t3/previous"), "old skill");
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex/AGENTS.md"), "old instructions");
  writeFileSync(
    join(home, "machines.json"),
    JSON.stringify([
      {
        id: hostname().split(".")[0].toLowerCase(),
        label: "Customer workstation",
        tag: "CW",
        role: "Builds",
        ssh: {},
        harnessFiles: [".codex/AGENTS.md"],
      },
    ]),
  );
  writeFileSync(join(home, "GLOBAL.md"), "Customer instructions\n");
  return {
    home,
    [Symbol.dispose]() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}
function install(home, args) {
  return spawnSync(process.execPath, [new URL("install.mjs", import.meta.url).pathname, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, T3CTL_AGENTS_CONFIG: home },
  });
}
test("installer discovers configured local machine, previews then backs up and installs", () => {
  using f = fixture();
  const dry = install(f.home, []);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(readFileSync(join(f.home, ".codex/AGENTS.md"), "utf8"), "old instructions");
  assert.equal(readFileSync(join(f.home, ".agents/skills/t3/previous"), "utf8"), "old skill");
  const applied = install(f.home, ["--apply"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(readFileSync(join(f.home, ".codex/AGENTS.md"), "utf8"), /Customer workstation.*CW/);
  assert.ok(existsSync(join(f.home, ".agents/skills/t3/scripts/t3ctl.mjs")));
  assert.ok(!existsSync(join(f.home, ".agents/skills/t3/scripts/t3ctl.unit.test.mjs")));
  const backups = join(f.home, ".local/state/t3-agent-kit");
  assert.equal(
    readFileSync(join(backups, readdirSync(backups)[0], "skill-t3/previous"), "utf8"),
    "old skill",
  );
});
test("staging supports arbitrary destination paths and unknown machines fail before writes", () => {
  using f = fixture();
  const staged = join(f.home, "staged skill");
  const result = install(f.home, ["--dest", staged]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(staged, "SKILL.md")));
  const rejected = install(f.home, ["--to", "unknown", "--apply"]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Unknown machine/);
  assert.equal(readFileSync(join(f.home, ".codex/AGENTS.md"), "utf8"), "old instructions");
});
