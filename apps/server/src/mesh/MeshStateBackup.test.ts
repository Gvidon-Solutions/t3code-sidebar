import * as Layer from "effect/Layer";
// @effect-diagnostics nodeBuiltinImport:off -- Exercise SQLite online backup against a private real WAL database.
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as Backup from "./MeshStateBackup.ts";
it.effect(
  "backs up committed WAL data before download and preserves the first snapshot when resumed",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesh-backup-" });
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        const db = new NodeSqlite.DatabaseSync(config.dbPath);
        try {
          db.exec(
            "PRAGMA journal_mode=WAL; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('before-download')",
          );
          const backup = yield* Backup.MeshStateBackup;
          yield* backup.create("lease-token");
          db.exec("UPDATE evidence SET value='after-switch'");
          yield* backup.create("lease-token");
          const snapshot = new NodeSqlite.DatabaseSync(
            `${root}/runtime/mesh-backup/lease-token/statev2.sqlite`,
            { readOnly: true },
          );
          try {
            expect(snapshot.prepare("SELECT value FROM evidence").get()).toEqual({
              value: "before-download",
            });
          } finally {
            snapshot.close();
          }
          for (let i = 0; i < 11; i++) {
            const old = `${root}/runtime/mesh-backup/old-${i}`;
            yield* fs.makeDirectory(old);
            yield* fs.writeFileString(`${old}/statev2.sqlite`, "historical");
            yield* fs.utimes(old, i, i);
          }
          const incomplete = `${root}/runtime/mesh-backup/incomplete`;
          yield* fs.makeDirectory(incomplete);
          yield* fs.writeFileString(`${incomplete}/statev2.sqlite.tmp`, "interrupted");
          yield* fs.utimes(incomplete, 0, 0);
          yield* TestClock.adjust("2 days");
          yield* backup.create("next-token");
          expect(yield* fs.exists(incomplete)).toBe(false);
          expect(yield* fs.readDirectory(`${root}/runtime/mesh-backup`)).toHaveLength(10);
          expect(yield* fs.exists(`${root}/runtime/mesh-backup/lease-token/statev2.sqlite`)).toBe(
            true,
          );
          expect(yield* fs.exists(`${root}/runtime/mesh-backup/next-token/statev2.sqlite`)).toBe(
            true,
          );
        } finally {
          db.close();
        }
      }).pipe(
        Effect.provide(Backup.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(root, root)))),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
