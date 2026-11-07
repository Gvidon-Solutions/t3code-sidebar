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
      writeFileSync(join(root, "ctl.mjs"), "console.log(JSON.stringify({current:{doc:{}}}));");
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
          }),
        );
      operation("prepare");
      operation("activate");
      assert.match(readFileSync(unit, "utf8"), /versions\/delivery\/2\/t3 serve --port 3795/);
      const migrated = new NodeSqlite.DatabaseSync(db);
      migrated.exec("UPDATE proof SET value='migrated-db'");
      migrated.close();
      operation("rollback");
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

test("target idle inspection includes projectless and child threads on every page", () => {
  const root = mkdtempSync(join(tmpdir(), "delivery-idle-"));
  try {
    const ctl = join(root, "ctl.mjs");
    writeFileSync(
      ctl,
      `const input=JSON.parse(process.argv[4]); if(!input.allProjects || !input.includeSubagents) throw new Error('scope'); console.log(JSON.stringify(input.cursor === 100 ? {threads:[{status:'running'}],nextCursor:null} : {threads:[{status:'idle'}],nextCursor:100}));`,
    );
    const result = execFileSync(
      process.execPath,
      [new URL("./target.mjs", import.meta.url).pathname],
      {
        encoding: "utf8",
        input: JSON.stringify({
          config: { runtimeDir: root, node: process.execPath, ctl, home: root },
          operation: "busy",
        }),
      },
    );
    assert.equal(JSON.parse(result), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
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
      `import fs from 'node:fs'; const file=${JSON.stringify(statusPath)}; const tool=process.argv[3]; const input=JSON.parse(process.argv[4]||'{}'); let status=JSON.parse(fs.readFileSync(file,'utf8')); if(tool==='t3_delivery_cancel_drain'){if(status.requestId!==input.requestId) throw new Error('mismatch'); status={requestId:null,phase:'open'}; fs.writeFileSync(file,JSON.stringify(status));} console.log(JSON.stringify(status));`,
    );
    const statePath = join(runtimeDir, "delivery-state.json");
    const state = {
      phase: "drained",
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
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).phase, "drained");
    writeFileSync(statusPath, JSON.stringify({ requestId, phase: "drained" }));
    operation("commit");
    assert.deepEqual(JSON.parse(readFileSync(statusPath, "utf8")), {
      requestId: null,
      phase: "open",
    });
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).phase, "healthy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
