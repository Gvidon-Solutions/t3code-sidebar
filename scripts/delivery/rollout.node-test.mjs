import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert.default;
import * as NodeFS from "node:fs";
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = NodeFS;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join } = NodePath;
import * as NodeChildProcess from "node:child_process";
const { execFileSync } = NodeChildProcess;
import { rollout, waitForIdle } from "./rollout.mjs";
import { snapshot } from "./builder.mjs";

const health = (version = "1", entries = { "proj/app": "001" }) => ({
  version,
  entries,
  revision: "r1",
  replicasReady: true,
});
const clock = () => ({
  value: 0,
  now() {
    return this.value;
  },
  async sleep(ms) {
    this.value += ms;
  },
});
test("idle window waits until all active turns finish and refuses at its deadline", async () => {
  const time = clock();
  let reads = 0;
  await waitForIdle({ busy: async () => ++reads < 3 }, { maxWaitMs: 10, intervalMs: 2 }, time);
  assert.equal(reads, 3);
  await assert.rejects(
    waitForIdle({ busy: async () => true }, { maxWaitMs: 4, intervalMs: 2 }, time),
    /Idle window deadline/,
  );
  await waitForIdle(
    {
      busy: async () => {
        throw new Error("must not inspect");
      },
    },
    { now: true },
    time,
  );
});
test("failed health restores runtime and stops before the next machine", async () => {
  const calls = [];
  let active = false;
  const studio = {
    name: "studio",
    busy: async () => false,
    prepare: async () => calls.push("backup"),
    activate: async () => {
      active = true;
      calls.push("activate");
    },
    rollback: async () => {
      active = false;
      calls.push("rollback");
    },
    health: async () => (active ? { ...health("2"), replicasReady: false } : health()),
  };
  const cloudbox = { ...studio, name: "cloudbox", prepare: async () => calls.push("cloudbox") };
  await assert.rejects(
    rollout([studio, cloudbox], "2", { maxWaitMs: 0, healthWaitMs: 0 }, async () => {}, clock()),
    /rolled back; rollout stopped: Replicas/,
  );
  assert.deepEqual(calls, ["backup", "activate", "rollback"]);
});
test("missing peer layout watermark rolls back even when version is correct", async () => {
  let active = false;
  let reverted = false;
  const adapter = {
    name: "studio",
    busy: async () => false,
    prepare: async () => {},
    activate: async () => {
      active = true;
    },
    rollback: async () => {
      active = false;
      reverted = true;
    },
    health: async () => (active ? health("2", {}) : health()),
  };
  await assert.rejects(
    rollout([adapter], "2", { maxWaitMs: 0, healthWaitMs: 0 }, async () => {}, clock()),
    /Layout has not converged/,
  );
  assert.equal(reverted, true);
});
test("hot snapshot includes staged, unstaged and untracked files without changing branch or index", () => {
  const dir = mkdtempSync(join(tmpdir(), "delivery-snapshot-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-b", "work");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    writeFileSync(join(dir, "file"), "before");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "base");
    writeFileSync(join(dir, "file"), "staged");
    git("add", "file");
    writeFileSync(join(dir, "file"), "unstaged");
    writeFileSync(join(dir, "new"), "untracked");
    const index = readFileSync(join(dir, ".git/index"));
    const before = git("rev-parse", "HEAD");
    const result = snapshot(dir, "test");
    assert.equal(git("branch", "--show-current"), "work");
    assert.equal(git("rev-parse", "HEAD"), before);
    assert.deepEqual(readFileSync(join(dir, ".git/index")), index);
    assert.equal(git("show", `${result.commit}:file`), "unstaged");
    assert.equal(git("show", `${result.commit}:new`), "untracked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("managed mesh version conflict refuses before stopping or preparing any target", async () => {
  let prepared = false;
  const adapter = {
    name: "studio",
    health: async () => ({ ...health(), desiredVersion: "1" }),
    prepare: async () => {
      prepared = true;
    },
  };
  await assert.rejects(
    rollout([adapter], "2", { maxWaitMs: 0, healthWaitMs: 0 }, async () => {}),
    /Managed mesh version/,
  );
  assert.equal(prepared, false);
});

test("delivery rejects a target outside the private allowlist before building", async () => {
  const { deliver } = await import("./builder.mjs");
  const dir = mkdtempSync(join(tmpdir(), "delivery-deny-"));
  try {
    await assert.rejects(
      deliver(
        { stateDir: dir, machines: [{ name: "studio" }] },
        { hot: true, machines: "unknown" },
      ),
      /not in delivery allowlist/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact selection skips native installers for a server or web only change", async () => {
  const { changedArtifacts } = await import("./assets.mjs");
  assert.deepEqual(changedArtifacts(["apps/server/src/server.ts", "apps/web/src/App.tsx"]), {
    desktop: false,
    mobile: false,
  });
  assert.deepEqual(changedArtifacts(["apps/desktop/src/main.ts"]), {
    desktop: true,
    mobile: false,
  });
  assert.deepEqual(changedArtifacts(["apps/mobile/src/App.tsx"]), { desktop: false, mobile: true });
});
