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
      assert.match(readFileSync(unit, "utf8"), /versions\/2\/t3 serve --port 3795/);
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
