import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  BUILD_FORK_MIGRATION_HEAD,
  databaseMigrationHead,
} from "../persistence/databaseMigrationHead.ts";
import { forkMigrationManifest, migrationManifest } from "../persistence/Migrations.ts";

import { runServicePreflight } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

// regression: #13239 a stale CLI shadowing the updated one kept "updating" to itself
it.each([1])("blocks legacy launcher protocol %i with exact recovery steps", (launcherProtocol) => {
  const result = runServicePreflight({
    databasePath: "/missing/state.sqlite",
    launcherProtocol,
    version: "9.8.7",
  });

  expect(result).toMatchObject({ status: "blocked", version: "9.8.7" });
  const reason = result.status === "blocked" ? result.reason : "";
  expect(reason).toMatch(new RegExp(`\\b${launcherProtocol}\\b`));
  expect(reason).toMatch(new RegExp(`\\b${SERVICE_LAUNCHER_PROTOCOL}\\b`));
  expect(reason).toContain("curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION=9.8.7 sh");
  expect(reason).toContain("~/.local/bin/t3 service install");
  expect(reason).toContain("t3 --version");
  expect(reason).toContain("which -a t3");
});

it.layer(NodeServices.layer)("service preflight database", (it) => {
  it.effect("blocks a database that a newer build migrated", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const databasePath = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-preflight-" }),
        "state.sqlite",
      );
      const db = new NodeSqlite.DatabaseSync(databasePath);
      db.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)");
      const insert = db.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
      for (const [id, name] of migrationManifest) insert.run(id, name);
      const preflight = () =>
        runServicePreflight({ databasePath, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL });

      expect(preflight().status).toBe("ready");
      // The fork ledger's reserved ids are part of the head too, so clients and releases agree.
      expect(databaseMigrationHead(databasePath)).toBe(BUILD_FORK_MIGRATION_HEAD);

      const newerId = Math.max(...migrationManifest.map(([id]) => id)) + 1;
      insert.run(newerId, "FromNightly");
      db.close();
      const result = preflight();
      expect(result.status).toBe("blocked");
      expect(result.status === "blocked" ? result.reason : "").toContain(`${newerId}_FromNightly`);
      // Servers report this head, so clients see a database a newer build migrated.
      expect(databaseMigrationHead(databasePath)).toBe(
        Math.max(BUILD_FORK_MIGRATION_HEAD, newerId),
      );

      // A database that exists but cannot be read has an unknown history, so it blocks.
      const unreadable = path.join(path.dirname(databasePath), "unreadable.sqlite");
      yield* fs.writeFileString(unreadable, "not a database");
      expect(databaseMigrationHead(unreadable)).toBeUndefined();
      expect(
        runServicePreflight({
          databasePath: unreadable,
          launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        }).status,
      ).toBe("blocked");
      // A missing database is a fresh install.
      expect(databaseMigrationHead(path.join(path.dirname(databasePath), "missing.sqlite"))).toBe(
        BUILD_FORK_MIGRATION_HEAD,
      );
    }),
  );

  it.effect("passes a live legacy fork database the startup reconcile will fix", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const databasePath = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-preflight-legacy-" }),
        "state.sqlite",
      );
      const db = new NodeSqlite.DatabaseSync(databasePath);
      db.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)");
      const insert = db.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
      // Upstream through 79, then the legacy fork rows. The highest upstream row used to be 80;
      // it is 81 now, so stop before the legacy range rather than below the head.
      for (const [id, name] of migrationManifest.filter(([id]) => id < 80)) {
        insert.run(id, name);
      }
      // The live shape: the pre-split fork wrote 80-84 into the upstream ledger.
      for (const [id, name] of [
        [80, "MeshLayout"],
        [81, "PeerConnections"],
        [82, "PeerIdentityBindings"],
        [83, "PeerReceiptRetention"],
        [84, "CloseTerminalRunNodes"],
      ] as const) {
        insert.run(id, name);
      }
      db.close();

      const result = runServicePreflight({
        databasePath,
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      });
      expect(result.status).toBe("ready");
      // The legacy ids are not newer than the build; the fork head is the honest head.
      expect(databaseMigrationHead(databasePath)).toBe(BUILD_FORK_MIGRATION_HEAD);
    }),
  );

  it.effect("blocks a database a newer fork build migrated, even though upstream is current", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const databasePath = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-preflight-fork-" }),
        "state.sqlite",
      );
      const db = new NodeSqlite.DatabaseSync(databasePath);
      db.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)");
      const upstream = db.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
      for (const [id, name] of migrationManifest) upstream.run(id, name);
      db.exec(
        "CREATE TABLE effect_sql_fork_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)",
      );
      const fork = db.prepare("INSERT INTO effect_sql_fork_migrations VALUES (?, ?)");
      for (const [id, name] of forkMigrationManifest) fork.run(id, name);
      const newerForkId = Math.max(...forkMigrationManifest.map(([id]) => id)) + 1;
      fork.run(newerForkId, "FromFutureFork");
      db.close();

      const result = runServicePreflight({
        databasePath,
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      });
      expect(result.status).toBe("blocked");
      expect(result.status === "blocked" ? result.reason : "").toContain(
        `${newerForkId}_FromFutureFork`,
      );
      expect(databaseMigrationHead(databasePath)).toBe(newerForkId);
      // No upstream row is above the upstream head, so only the fork ledger can have blocked it.
      expect(BUILD_FORK_MIGRATION_HEAD).toBeLessThan(newerForkId);
    }),
  );
});
