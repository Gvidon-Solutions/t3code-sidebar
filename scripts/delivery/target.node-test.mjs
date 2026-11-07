import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert.default;
import * as NodeFS from "node:fs";
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = NodeFS;
import * as NodeChildProcess from "node:child_process";
const { execFileSync } = NodeChildProcess;
import * as NodeOS from "node:os";
const { tmpdir } = NodeOS;
import * as NodePath from "node:path";
const { join } = NodePath;
import * as NodeSqlite from "node:sqlite";

test("isolated target switches its configured unit and restores the exact previous DB and executable", () => {
  for (const scope of ["user", "system"]) {
    const root = mkdtempSync(join(tmpdir(), "delivery-target-"));
    try {
      const binaryDir = join(root, "bin");
      mkdirSync(binaryDir);
      const calls = join(root, "calls");
      const systemctl = join(binaryDir, "systemctl");
      writeFileSync(systemctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`);
      chmodSync(systemctl, 0o755);
      const home = join(root, "home");
      mkdirSync(join(home, "userdata"), { recursive: true });
      const db = join(home, "userdata/statev2.sqlite");
      const database = new NodeSqlite.DatabaseSync(db);
      database.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('previous-db')");
      database.close();
      const unit = join(root, "test.service");
      const original = "[Service]\nExecStart=/old/runtime/t3 serve --port 3795\n";
      writeFileSync(unit, original);
      const archive = join(root, "runtime.tar.gz");
      mkdirSync(join(root, "stage"));
      writeFileSync(join(root, "stage/t3"), "new-runtime");
      execFileSync("tar", ["czf", archive, "-C", root, "stage"]);
      writeFileSync(
        join(root, "ctl.mjs"),
        `import fs from "node:fs"; const file=${JSON.stringify(join(root, "gate.json"))}; const tool=process.argv[3]; let state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{requestId:null,phase:"open"}; if(tool==="t3_delivery_drain"){const input=JSON.parse(process.argv[4]);state={requestId:input.requestId,phase:input.now?"draining":"drained",activeRuns:input.now?1:0};fs.writeFileSync(file,JSON.stringify(state));} if(tool==="t3_delivery_cancel_drain"){state={requestId:null,phase:"open"};fs.writeFileSync(file,JSON.stringify(state));} console.log(JSON.stringify(tool?.startsWith("t3_delivery_")?state:tool==="t3_mesh_update_health"?{version:"1",revision:"r1",entries:{},replicasReady:true}:{current:{doc:{}}}));`,
      );
      const config = {
        runtimeDir: join(root, "versions"),
        home,
        unitPath: unit,
        scope,
        unit: "app-test.service",
        node: process.execPath,
        ctl: join(root, "ctl.mjs"),
        origin: "http://127.0.0.1:3795",
        archive,
        version: "2",
        now: true,
      };
      const operation = (name) =>
        JSON.parse(
          execFileSync(process.execPath, [new URL("./target.mjs", import.meta.url).pathname], {
            encoding: "utf8",
            input: JSON.stringify({ config, operation: name }),
            env: { ...process.env, PATH: `${binaryDir}:${process.env.PATH}` },
            stdio: ["pipe", "pipe", "pipe"],
          }),
        );
      operation("prepare");
      assert.throws(() => operation("activate"), /admission fence has not been acquired/);
      operation("rollback");
      assert.equal(NodeFS.existsSync(join(config.runtimeDir, "delivery", "2")), false);
      operation("prepare");
      operation("drain");
      assert.equal(JSON.parse(readFileSync(join(root, "gate.json"), "utf8")).phase, "draining");
      operation("activate");
      assert.match(readFileSync(unit, "utf8"), /versions\/delivery\/2\/t3 serve --port 3795/);
      const migrated = new NodeSqlite.DatabaseSync(db);
      migrated.exec("UPDATE proof SET value='migrated-db'");
      migrated.close();
      operation("commit");
      assert.throws(() => operation("rollback"), /Rollback admission fence has not been acquired/);
      assert.match(readFileSync(unit, "utf8"), /versions\/delivery\/2\/t3 serve/);
      config.now = false;
      operation("prepareRollback");
      assert.equal(JSON.parse(readFileSync(join(root, "gate.json"), "utf8")).phase, "drained");
      const fencedDb = new NodeSqlite.DatabaseSync(db);
      fencedDb.exec("CREATE TABLE delivery_admission (id INTEGER PRIMARY KEY, request_id TEXT)");
      fencedDb
        .prepare("INSERT INTO delivery_admission VALUES (1, ?)")
        .run(JSON.parse(readFileSync(join(root, "gate.json"), "utf8")).requestId);
      fencedDb.close();
      const workingCtl = readFileSync(config.ctl, "utf8");
      writeFileSync(config.ctl, "throw new Error('trial HTTP unavailable');");
      operation("rollback");
      writeFileSync(config.ctl, workingCtl);
      operation("cancelDrain");
      const restored = new NodeSqlite.DatabaseSync(db, { readOnly: true });
      assert.equal(restored.prepare("SELECT value FROM proof").get().value, "previous-db");
      restored.close();
      assert.equal(readFileSync(unit, "utf8"), original);
      const intervening = new NodeSqlite.DatabaseSync(db);
      intervening.exec("UPDATE proof SET value='new-turn-after-rollback'");
      intervening.close();
      operation("rollback");
      const afterRetry = new NodeSqlite.DatabaseSync(db, { readOnly: true });
      assert.equal(
        afterRetry.prepare("SELECT value FROM proof").get().value,
        "new-turn-after-rollback",
      );
      afterRetry.close();
      assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
        `${scope === "user" ? "--user " : ""}stop app-test.service`,
        `${scope === "user" ? "--user " : ""}daemon-reload`,
        `${scope === "user" ? "--user " : ""}start app-test.service`,
        `${scope === "user" ? "--user " : ""}stop app-test.service`,
        `${scope === "user" ? "--user " : ""}daemon-reload`,
        `${scope === "user" ? "--user " : ""}start app-test.service`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("target requires its matching drained admission fence and releases it only after a healthy commit", () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-fence-"));
  try {
    const runtimeDir = join(root, "versions");
    mkdirSync(runtimeDir);
    const unitPath = join(root, "app.service");
    writeFileSync(unitPath, "ExecStart=/old/t3 serve\n");
    const ctl = join(root, "ctl.mjs");
    const statusPath = join(root, "status.json");
    const requestId = "fence-request";
    writeFileSync(statusPath, JSON.stringify({ requestId, phase: "drained" }));
    writeFileSync(
      ctl,
      `import fs from 'node:fs'; const file=${JSON.stringify(statusPath)}; const tool=process.argv[3]; const input=JSON.parse(process.argv[4]||'{}'); let status=JSON.parse(fs.readFileSync(file,'utf8')); if(status.unsupported) throw new Error('Unknown tool: delivery drain'); if(tool==='t3_delivery_cancel_drain'){if(status.requestId!==input.requestId) throw new Error('mismatch'); status={requestId:null,phase:'open'}; fs.writeFileSync(file,JSON.stringify(status));} console.log(JSON.stringify(status));`,
    );
    const statePath = join(runtimeDir, "delivery-state.json");
    const state = {
      phase: "fenced",
      now: false,
      requestId,
      unit: "ExecStart=/old/t3 serve\n",
      next: "ExecStart=/new/t3 serve\n",
      previousHealth: { version: "1", revision: "r1", entries: {}, replicasReady: true },
    };
    writeFileSync(statePath, JSON.stringify(state));
    const config = {
      runtimeDir,
      home: root,
      node: process.execPath,
      ctl,
      unitPath,
      scope: "user",
      unit: "app.service",
    };
    const operation = (name) =>
      execFileSync(process.execPath, [new URL("./target.mjs", import.meta.url).pathname], {
        encoding: "utf8",
        input: JSON.stringify({ config, operation: name }),
        stdio: ["pipe", "pipe", "pipe"],
      });
    writeFileSync(statusPath, JSON.stringify({ requestId: "other-request", phase: "drained" }));
    assert.throws(() => operation("activate"), /admission fence was lost/);
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).phase, "fenced");
    writeFileSync(statusPath, JSON.stringify({ requestId, phase: "drained" }));
    assert.throws(() => operation("commit"), /Only a runtime trial/);
    writeFileSync(statePath, JSON.stringify({ ...state, phase: "trial" }));
    operation("commit");
    assert.deepEqual(JSON.parse(readFileSync(statusPath, "utf8")), {
      requestId: null,
      phase: "open",
    });
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).phase, "healthy");
    const prepared = { ...state, phase: "prepared" };
    delete prepared.requestId;
    writeFileSync(statePath, JSON.stringify(prepared));
    writeFileSync(statusPath, JSON.stringify({ unsupported: true }));
    assert.throws(() => operation("drain"), /Unknown tool: delivery drain/);
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).phase, "prepared");
    operation("rollback");
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).phase, "rolledBack");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("system target diagnostics prove execution without a GitHub CLI", () => {
  const result = JSON.parse(
    execFileSync(process.execPath, [new URL("./target.mjs", import.meta.url).pathname], {
      encoding: "utf8",
      input: JSON.stringify({
        config: { runtimeDir: "/unused", scope: "system" },
        operation: "capabilities",
      }),
      env: { ...process.env, PATH: "" },
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  assert.deepEqual(result, { hasGh: false, scope: "system" });
});

test("bed bootstrap refuses unrelated units and pre-existing non-fixture databases", () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-bootstrap-"));
  try {
    const script = new URL("./bed-target.mjs", import.meta.url).pathname;
    const machine = {
      home: root,
      unit: "application.service",
      unitPath: join(root, "application.service"),
      sshdPort: 22222,
    };
    const invoke = (value) =>
      execFileSync(process.execPath, [script], {
        encoding: "utf8",
        input: JSON.stringify({ machine: value, archive: "unused" }),
        stdio: ["pipe", "pipe", "pipe"],
      });
    assert.throws(() => invoke(machine), /only manages D1-prefixed/);
    mkdirSync(join(root, "userdata"));
    writeFileSync(join(root, "userdata/statev2.sqlite"), "foreign database");
    assert.throws(
      () => invoke({ ...machine, unit: "D1-app.service", unitPath: join(root, "D1-app.service") }),
      /pre-existing non-fixture/,
    );
    assert.equal(readFileSync(join(root, "userdata/statev2.sqlite"), "utf8"), "foreign database");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
