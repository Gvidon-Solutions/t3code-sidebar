import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert.default;
import { waitForLegacyIdle, isMissingDrain } from "./target.mjs";

test("legacy idle waits for busy turns, bounds waiting and allows explicit interruption", async () => {
  let time = 0;
  let calls = 0;
  const clock = {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
  const listRunning = () => (++calls < 3 ? [{ id: "turn" }] : []);
  await waitForLegacyIdle({ listRunning, maxWaitMs: 3000, clock });
  assert.equal(calls, 3);
  assert.equal(time, 2000);
  await assert.rejects(
    waitForLegacyIdle({ listRunning: () => [{ id: "busy" }], maxWaitMs: 500, clock }),
    /Legacy target did not become idle/,
  );
  await waitForLegacyIdle({
    listRunning: () => {
      throw new Error("should not query");
    },
    now: true,
    maxWaitMs: 1,
    clock,
  });
  await assert.rejects(
    waitForLegacyIdle({
      listRunning: () => {
        throw new Error("unauthorized");
      },
      maxWaitMs: 500,
      clock,
    }),
    /unauthorized/,
  );
  await assert.rejects(
    waitForLegacyIdle({ listRunning: () => ({}), maxWaitMs: 500, clock }),
    /Invalid running-thread response/,
  );
});

test("legacy capability detection accepts only the missing drain tool", () => {
  assert.equal(
    isMissingDrain({ stderr: "t3ctl: MCP tools/call: Tool 't3_delivery_drain_status' not found" }),
    true,
  );
  assert.equal(isMissingDrain(new Error("connection refused")), false);
  assert.equal(isMissingDrain({ stderr: "401 unauthorized" }), false);
});

test("target chooses legacy admission only while its runtime lacks drain", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { targetOperation } = await import("./target.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-legacy-"));
  try {
    const ctl = path.join(root, "ctl.mjs");
    const unitPath = path.join(root, "test.service");
    fs.writeFileSync(unitPath, "ExecStart=/old/t3 serve\n");
    fs.writeFileSync(
      ctl,
      `import fs from 'node:fs'; const root=${JSON.stringify(root)}; const name=process.argv[3]; if(process.argv[2]==='threads') { fs.appendFileSync(root+'/calls','threads\\n'); console.log('[]'); } else if(name==='t3_delivery_drain_status' && !fs.existsSync(root+'/modern')) { console.error("Tool 't3_delivery_drain_status' not found"); process.exit(1); } else { const input=JSON.parse(process.argv[4]||'{}'); console.log(JSON.stringify(name==='t3_delivery_drain'?{requestId:input.requestId,phase:'drained'}:{})); }`,
    );
    const statePath = path.join(root, "delivery-state.json");
    const prepared = { phase: "prepared" };
    fs.writeFileSync(statePath, JSON.stringify(prepared));
    const config = {
      runtimeDir: root,
      home: root,
      unitPath,
      node: process.execPath,
      ctl,
      maxWaitMs: 10000,
    };
    const legacy = await targetOperation(config, "drain");
    assert.equal(legacy.mode, "legacy-idle");
    assert.equal(legacy.fenced, false);
    assert.equal(fs.readFileSync(path.join(root, "calls"), "utf8"), "threads\n");
    assert.equal(JSON.parse(fs.readFileSync(statePath)).previousAdmission, "legacy-idle");
    fs.writeFileSync(path.join(root, "modern"), "yes");
    fs.writeFileSync(statePath, JSON.stringify(prepared));
    const modern = await targetOperation(config, "drain");
    assert.equal(modern.phase, "drained");
    assert.equal(JSON.parse(fs.readFileSync(statePath)).admission, "drain");
    assert.equal(fs.readFileSync(path.join(root, "calls"), "utf8"), "threads\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy runtime trial restores a database without the admission table", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const cp = await import("node:child_process");
  const { DatabaseSync } = await import("node:sqlite");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-legacy-restore-"));
  try {
    fs.mkdirSync(path.join(root, "userdata"));
    fs.mkdirSync(path.join(root, "bin"));
    fs.mkdirSync(path.join(root, "stage"));
    const db = new DatabaseSync(path.join(root, "userdata/statev2.sqlite"));
    db.exec(
      "CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES ('legacy'); CREATE TABLE mesh_layout_generation (id TEXT PRIMARY KEY, generation TEXT); INSERT INTO mesh_layout_generation VALUES ('local','old-generation'); CREATE TABLE mesh_peer_state (environment_id TEXT); INSERT INTO mesh_peer_state VALUES ('peer')",
    );
    db.close();
    fs.writeFileSync(path.join(root, "bin/systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(root, "stage/t3"), "runtime");
    cp.execFileSync("tar", ["czf", path.join(root, "runtime.tar.gz"), "-C", root, "stage"]);
    const unitPath = path.join(root, "test.service");
    const unit = "ExecStart=/old/t3 serve\n";
    fs.writeFileSync(unitPath, unit);
    const ctl = path.join(root, "ctl.mjs");
    fs.writeFileSync(
      ctl,
      `const name=process.argv[3]; if(name==='t3_delivery_drain_status'){console.error("Tool 't3_delivery_drain_status' not found");process.exit(1);} console.log(JSON.stringify(process.argv[2]==='threads'?[]:name==='t3_mesh_update_health'?{version:'old',revision:'r',entries:{},replicasReady:true}:{current:{doc:{}}}));`,
    );
    const config = {
      runtimeDir: path.join(root, "versions"),
      home: root,
      unitPath,
      ctl,
      node: process.execPath,
      scope: "user",
      unit: "fixture.service",
      archive: path.join(root, "runtime.tar.gz"),
      version: "new",
      maxWaitMs: 10000,
    };
    const operation = (name) =>
      JSON.parse(
        cp.execFileSync(process.execPath, [new URL("./target.mjs", import.meta.url).pathname], {
          input: JSON.stringify({ config, operation: name }),
          encoding: "utf8",
          env: { ...process.env, PATH: path.join(root, "bin") + path.delimiter + process.env.PATH },
        }),
      );
    operation("prepare");
    assert.equal(operation("drain").mode, "legacy-idle");
    operation("activate");
    const migrated = new DatabaseSync(path.join(root, "userdata/statev2.sqlite"));
    migrated.exec("UPDATE proof SET value='trial'; CREATE TABLE delivery_admission (id INTEGER)");
    migrated.close();
    operation("rollback");
    const restored = new DatabaseSync(path.join(root, "userdata/statev2.sqlite"));
    assert.equal(restored.prepare("SELECT value FROM proof").get().value, "legacy");
    assert.equal(
      restored.prepare("SELECT count(*) n FROM sqlite_master WHERE name='delivery_admission'").get()
        .n,
      0,
    );
    restored.close();
    const layoutDb = new DatabaseSync(path.join(root, "userdata/statev2.sqlite"));
    assert.equal(layoutDb.prepare("SELECT count(*) n FROM mesh_layout_generation").get().n, 0);
    assert.equal(layoutDb.prepare("SELECT count(*) n FROM mesh_peer_state").get().n, 0);
    layoutDb.close();
    assert.equal(fs.readFileSync(unitPath, "utf8"), unit);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("N-1 health watermarks follow canonical title migration without losing clocks", async () => {
  const { canonicalHealth } = await import("./target.mjs");
  const health = {
    entries: {
      "proj/app": "01",
      "proj/app.title": "02",
      "proj/app.title.title": "03",
      "projTitle/app": "04",
    },
  };
  const doc = {
    "proj/app": { v: { title: "app" } },
    "proj/app.title": { v: { title: "A real id ending in .title" } },
    "proj/app.title.title": { v: "Title of that project" },
  };
  assert.deepEqual(canonicalHealth(health, doc).entries, {
    "proj/app": "01",
    "proj/app.title": "02",
    "projTitle/app.title": "03",
    "projTitle/app": "04",
  });
  assert.deepEqual(
    canonicalHealth(
      { entries: { "proj/app.title": "02", "projTitle/app": "04" } },
      { "proj/app.title": { v: "Title" } },
    ).entries,
    { "projTitle/app": "04" },
  );
});
