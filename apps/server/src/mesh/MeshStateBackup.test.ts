import * as Layer from "effect/Layer";
// @effect-diagnostics nodeBuiltinImport:off -- Exercise SQLite online backup against a private real WAL database.
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../config.ts";
import * as Backup from "./MeshStateBackup.ts";
it.effect(
  "backs up committed WAL data before download and preserves the first snapshot when resumed",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "B1-backup-" });
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
        } finally {
          db.close();
        }
      }).pipe(
        Effect.provide(Backup.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(root, root)))),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
