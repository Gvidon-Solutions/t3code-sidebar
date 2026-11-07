import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert.default;
import * as NodeFS from "node:fs";
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = NodeFS;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join } = NodePath;
import * as NodeChildProcess from "node:child_process";
const { execFileSync } = NodeChildProcess;
import { rollout } from "./rollout.mjs";
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
test("failed health restores runtime and stops before the next machine", async () => {
  const calls = [];
  let active = false;
  let recovering = false;
  let recoveryReads = 0;
  const studio = {
    name: "studio",
    busy: async () => false,
    prepare: async () => calls.push("prepare"),
    drain: async () => calls.push("drain"),
    activate: async () => {
      active = true;
      calls.push("activate");
    },
    rollback: async () => {
      active = false;
      recovering = true;
      calls.push("rollback");
    },
    health: async () => {
      if (recovering && recoveryReads++ === 0) throw new Error("Old runtime still starting");
      return active ? { ...health("2"), replicasReady: false } : health();
    },
  };
  const cloudbox = { ...studio, name: "cloudbox", prepare: async () => calls.push("cloudbox") };
  await assert.rejects(
    rollout([studio, cloudbox], "2", { maxWaitMs: 0, healthWaitMs: 2 }, async () => {}, clock()),
    /rolled back; rollout stopped: Replicas/,
  );
  assert.deepEqual(calls, ["prepare", "drain", "activate", "rollback"]);
});
test("missing peer layout watermark rolls back even when version is correct", async () => {
  let active = false;
  let reverted = false;
  const adapter = {
    name: "studio",
    busy: async () => false,
    prepare: async () => {},
    drain: async () => {},
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
    mkdirSync(join(dir, "nested"));
    const result = snapshot(join(dir, "nested"), "test");
    assert.equal(result.worktree, dir);
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

test("delivery rejects unsafe requests before building", async () => {
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
    await assert.rejects(
      deliver({ stateDir: dir, machines: [{ name: "studio" }] }, { hot: true }),
      /Configure cleanAgent.project/,
    );
    await assert.rejects(
      deliver(
        { stateDir: dir, machines: [{ name: "studio" }] },
        { hot: true, now: true, release: "public-tag" },
      ),
      /never publish/,
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
  assert.deepEqual(
    changedArtifacts([
      "apps/desktop/src/app/DesktopApp.test.ts",
      "apps/desktop/scripts/delivery-ui-proof.mjs",
    ]),
    { desktop: false, mobile: false },
  );
});

test("default delivery version preserves the ref's compatibility core and newer upstream sync core", async () => {
  const { versionForDelivery } = await import("./builder.mjs");
  assert.equal(
    versionForDelivery(
      "1.6.2-sidebar.8",
      "Last synced with upstream release `v1.7.0`",
      true,
      "20300102T030405Z",
    ),
    "1.7.0-hot.20300102030405",
  );
  assert.equal(
    versionForDelivery(
      "2.0.1",
      "Last synced with upstream release `v1.9.9`",
      false,
      "20300102T030405Z",
    ),
    "2.0.1-delivery.20300102030405",
  );
  assert.equal(
    versionForDelivery("1.6.2", "No upstream marker", true, "20300102T030405Z"),
    "1.6.2-hot.20300102030405",
  );
  assert.throws(
    () => versionForDelivery("invalid", "", true, "20300102T030405Z"),
    /Invalid server package version/,
  );
});

test("a failed admission drain never activates a runtime and releases its preparation", async () => {
  const calls = [];
  const adapter = {
    name: "studio",
    health: async () => health(),
    prepare: async () => calls.push("prepare"),
    drain: async () => {
      calls.push("drain");
      throw new Error("Drain deadline exceeded");
    },
    activate: async () => calls.push("activate"),
    rollback: async () => calls.push("rollback-preparation"),
    release: async () => calls.push("release"),
  };
  await assert.rejects(
    rollout([adapter], "2", { maxWaitMs: 0, healthWaitMs: 0 }, async () => {}),
    /Drain deadline exceeded/,
  );
  assert.deepEqual(calls, ["prepare", "drain", "rollback-preparation", "release"]);
});

test("private builder reports idle state and refuses another listener or a non-socket path", async () => {
  const { serve } = await import("./builder.mjs");
  const NodeHttp = await import("node:http");
  const root = mkdtempSync(join(tmpdir(), "delivery-service-"));
  const socket = join(root, "builder.sock");
  let server;
  try {
    server = await serve({ socket });
    await assert.rejects(serve({ socket }), /already listening/);
    const status = await new Promise((resolve, reject) => {
      const req = NodeHttp.get({ socketPath: socket, path: "/status" }, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(JSON.parse(body)));
        res.on("error", reject);
      });
      req.on("error", reject);
    });
    assert.deepEqual(status, { state: "idle", queued: 0, active: null });
    await new Promise((resolve) => server.close(resolve));
    server = null;
    writeFileSync(socket, "do not replace");
    await assert.rejects(serve({ socket }), /non-socket/);
    assert.equal(readFileSync(socket, "utf8"), "do not replace");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the isolated fixture gate refuses production use and records an explicit authorized invocation", () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-gate-"));
  try {
    const script = new URL("./fixture-gate.mjs", import.meta.url).pathname;
    assert.throws(
      () =>
        execFileSync(process.execPath, [script], {
          env: { ...process.env, T3_DELIVERY_FIXTURE_GATE: "" },
          stdio: ["ignore", "pipe", "pipe"],
        }),
      /coordinator-authorized D1/,
    );
    const path = join(root, "gate.jsonl");
    execFileSync(process.execPath, [script], {
      env: { ...process.env, T3_DELIVERY_FIXTURE_GATE: "1", T3_DELIVERY_FIXTURE_GATE_LOG: path },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).fixture, "D1 delivery gate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed runtime health leaves phone catalogs unchanged; only healthy rollout promotes the signed candidate", async () => {
  const { rolloutAndPublish } = await import("./builder.mjs");
  const root = mkdtempSync(join(tmpdir(), "delivery-ota-transaction-"));
  try {
    const candidate = join(root, "candidate"),
      committed = join(root, "successful-store"),
      home = join(root, "studio");
    for (const dir of [candidate, committed, join(home, "mobile-updates")]) {
      mkdirSync(join(dir, "assets"), { recursive: true });
      writeFileSync(join(dir, "certificate.pem"), "certificate");
      writeFileSync(
        join(dir, "catalog.json"),
        JSON.stringify({ id: dir === candidate ? "new" : "old" }),
      );
    }
    writeFileSync(join(candidate, "assets/new-hash"), "new bundle");
    let active = false,
      healthy = false,
      fenced = false;
    const adapter = {
      name: "studio",
      health: async () => ({ ...health(active ? "2" : "1"), replicasReady: !active || healthy }),
      prepare: async () => {},
      drain: async () => {
        fenced = true;
      },
      activate: async () => {
        assert.equal(fenced, true, "--now must still fence new submissions");
        active = true;
      },
      rollback: async () => {
        active = false;
        fenced = false;
      },
    };
    const input = {
      adapters: [adapter],
      version: "2",
      options: { now: true, healthWaitMs: 0 },
      journal: async () => {},
      mobileUpdate: { store: candidate },
      config: { ota: { store: committed } },
      machines: [{ home }],
    };
    await assert.rejects(rolloutAndPublish(input), /Replicas have not resumed/);
    assert.equal(JSON.parse(readFileSync(join(committed, "catalog.json"), "utf8")).id, "old");
    assert.equal(
      JSON.parse(readFileSync(join(home, "mobile-updates/catalog.json"), "utf8")).id,
      "old",
    );
    healthy = true;
    await rolloutAndPublish(input);
    assert.equal(JSON.parse(readFileSync(join(committed, "catalog.json"), "utf8")).id, "new");
    assert.equal(
      JSON.parse(readFileSync(join(home, "mobile-updates/catalog.json"), "utf8")).id,
      "new",
    );
    assert.equal(readFileSync(join(home, "mobile-updates/assets/new-hash"), "utf8"), "new bundle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stable layout key created during startup must reach fresh peer health before the next switch", async () => {
  let active = false,
    nextPrepared = false;
  const studio = {
    name: "studio",
    health: async () =>
      health(
        active ? "2" : "1",
        active ? { "proj/app": "001", "new/key": "002" } : { "proj/app": "001" },
      ),
    prepare: async () => {},
    drain: async () => {},
    activate: async () => {
      active = true;
    },
    rollback: async () => {
      active = false;
    },
  };
  const cloudbox = {
    ...studio,
    name: "cloudbox",
    health: async () => health(),
    prepare: async () => {
      nextPrepared = true;
    },
  };
  await assert.rejects(
    rollout([studio, cloudbox], "2", { healthWaitMs: 0 }, async () => {}),
    /Peer layout has not converged: new\/key/,
  );
  assert.equal(nextPrepared, false);
  assert.equal(active, false);
});
