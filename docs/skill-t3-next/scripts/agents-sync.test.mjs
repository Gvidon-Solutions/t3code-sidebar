import * as NodeTest from "node:test";
const test = NodeTest;
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import * as NodeFS from "node:fs";
const fs = NodeFS;
import * as NodeOS from "node:os";
const os = NodeOS;
import * as NodePath from "node:path";
const path = NodePath;
import { render, unifiedDiff, targetOperation } from "./agents-sync.mjs";

test.test("render preserves the entire canonical body with only a machine header", () => {
  const machines = [
    { id: "gor", label: "gor", tag: "GOR", role: "стенд" },
    { id: "gv", label: "gvidon", tag: "GV" },
  ];
  const body = "# Антон\n\nБез изменений.\n";
  assert.equal(
    render(machines[0], machines, body),
    "> Эта машина — **gor** (GOR): стенд; соседние: gvidon (GV).\n\n" + body,
  );
});
test.test("unified diff handles missing, drift, equal files and absent final newline", () => {
  assert.equal(unifiedDiff("a\n", "a\n", "file"), "");
  const diff = unifiedDiff("old\n", "new\n", "file");
  assert.match(diff, /--- file \(old\)/);
  assert.match(diff, /\+\+\+ file \(rendered\)/);
  assert.match(diff, /-old\n\+new/);
  assert.match(unifiedDiff("", "new", "missing"), /No newline at end of file/);
});
test.test("target read is non-mutating; apply backs up, verifies, and is idempotent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-agents-test-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, ".codex"));
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".codex/AGENTS.md"), "old");
    const input = {
      operation: "read",
      files: [".codex/AGENTS.md", ".claude/CLAUDE.md", ".config/opencode/AGENTS.md"],
      content: "new",
      stamp: "test",
    };
    assert.deepEqual(
      targetOperation(input).map((r) => r.state),
      ["differs", "missing", "harness absent"],
    );
    assert.equal(fs.readFileSync(path.join(home, ".codex/AGENTS.md"), "utf8"), "old");
    assert.equal(fs.existsSync(path.join(home, ".local")), false);
    const rows = targetOperation({ ...input, operation: "apply" });
    assert.equal(fs.readFileSync(rows[0].backup, "utf8"), "old");
    assert.equal(fs.readFileSync(rows[1].backup + ".missing", "utf8"), "File did not exist\n");
    assert.equal(fs.readFileSync(path.join(home, ".codex/AGENTS.md"), "utf8"), "new");
    assert.equal(rows[0].verified, true);
    assert.deepEqual(
      targetOperation(input).map((r) => r.state),
      ["in sync", "in sync", "harness absent"],
    );
    assert.equal(targetOperation({ ...input, operation: "apply" })[0].backup, undefined);
    assert.throws(() => targetOperation({ ...input, files: ["../escape"] }), /Invalid harness/);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test.test("canonical body retains the reviewed mesh clarification bytes", async () => {
  const { createHash } = await import("node:crypto");
  const body = fs.readFileSync(new URL("../global/GLOBAL.md", import.meta.url));
  assert.equal(
    createHash("sha256").update(body).digest("hex"),
    "848cc01ba1cb3b91a54ee093a9347b94e765aa0543560c8f72e604e5b91711c8",
  );
});

test.test("backup collision refuses the write and preserves the current file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-agents-collision-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, ".codex"));
    const dest = path.join(home, ".codex/AGENTS.md");
    fs.writeFileSync(dest, "old");
    const input = {
      operation: "apply",
      files: [".codex/AGENTS.md"],
      content: "first",
      stamp: "same",
    };
    targetOperation(input);
    assert.throws(() => targetOperation({ ...input, content: "second" }), { code: "EEXIST" });
    assert.equal(fs.readFileSync(dest, "utf8"), "first");
    assert.equal(
      fs.readFileSync(path.join(home, ".local/state/t3-agents-sync/same/.codex/AGENTS.md"), "utf8"),
      "old",
    );
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test.test(
  "SSH sync transports Unicode safely, defaults to diff, then verifies backed-up writes",
  async () => {
    const { spawnSync } = await import("node:child_process");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-agents-ssh-"));
    try {
      fs.mkdirSync(path.join(home, ".codex"));
      fs.writeFileSync(path.join(home, ".codex/AGENTS.md"), "original\n");
      fs.writeFileSync(
        path.join(home, "ssh"),
        `#!${process.execPath}\nconst cp=require('node:child_process'); const r=cp.spawnSync('/bin/sh',['-c',process.argv.at(-1)],{stdio:'inherit'});process.exit(r.status ?? 1);\n`,
        { mode: 0o700 },
      );
      const moduleUrl = new URL("./agents-sync.mjs", import.meta.url).href;
      const call = (opt) =>
        spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; os.hostname=()=> 'gvidon'; syncBuiltinESMExports(); const {runAgents}=await import(${JSON.stringify(moduleUrl)}); runAgents(['sync'],${JSON.stringify(opt)});`,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, HOME: home, PATH: home + ":" + process.env.PATH },
          },
        );
      const dry = call({ to: "gor" });
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /-original/);
      assert.match(dry.stdout, /\+> Эта машина — \*\*gor\*\*/);
      assert.equal(fs.readFileSync(path.join(home, ".codex/AGENTS.md"), "utf8"), "original\n");
      const apply = call({ to: "gor", apply: true });
      assert.equal(apply.status, 0, apply.stderr);
      assert.match(apply.stdout, /in sync \(verified\)/);
      const state = path.join(home, ".local/state/t3-agents-sync");
      assert.equal(
        fs.readFileSync(path.join(state, fs.readdirSync(state)[0], ".codex/AGENTS.md"), "utf8"),
        "original\n",
      );
      assert.match(
        fs.readFileSync(path.join(home, ".codex/AGENTS.md"), "utf8"),
        /Привет! Меня зовут Антон/,
      );
      const unknown = call({ to: "unknown" });
      assert.notEqual(unknown.status, 0);
      assert.match(unknown.stderr, /Unknown machine unknown/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);

test.test(
  "explicit isolated HOME targets only local files and rejects remote or relative targets",
  async () => {
    const { spawnSync } = await import("node:child_process");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-agents-home-"));
    const isolated = path.join(home, "isolated");
    try {
      fs.mkdirSync(path.join(home, ".codex"));
      fs.mkdirSync(path.join(isolated, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(home, ".codex/AGENTS.md"), "untouched");
      const moduleUrl = new URL("./agents-sync.mjs", import.meta.url).href;
      const call = (opt, operation = "sync") =>
        spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; os.hostname=()=> 'gvidon'; syncBuiltinESMExports(); const {runAgents}=await import(${JSON.stringify(moduleUrl)}); runAgents([${JSON.stringify(operation)}],${JSON.stringify(opt)});`,
          ],
          { encoding: "utf8", env: { ...process.env, HOME: home } },
        );
      const dry = call({ home: isolated });
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /missing/);
      assert.equal(fs.existsSync(path.join(isolated, ".codex/AGENTS.md")), false);
      const apply = call({ home: isolated, apply: true });
      assert.equal(apply.status, 0, apply.stderr);
      assert.match(call({ home: isolated }, "status").stdout, /in sync/);
      assert.match(
        fs.readFileSync(path.join(isolated, ".codex/AGENTS.md"), "utf8"),
        /Эта машина — \*\*gvidon\*\*/,
      );
      assert.equal(fs.readFileSync(path.join(home, ".codex/AGENTS.md"), "utf8"), "untouched");
      for (const opt of [
        { home: "relative" },
        { home: isolated, to: "gor" },
        { home: isolated, to: "all" },
      ]) {
        const rejected = call(opt);
        assert.notEqual(rejected.status, 0);
        assert.match(rejected.stderr, /--home requires/);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);
