// @effect-diagnostics nodeBuiltinImport:off -- SQLite's online backup API creates a consistent pre-download snapshot while the server is running.
import * as NodeSqlite from "node:sqlite";
import { MeshConfigError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
export class MeshStateBackup extends Context.Service<
  MeshStateBackup,
  { readonly create: (token: string) => Effect.Effect<void, MeshConfigError> }
>()("t3/mesh/MeshStateBackup") {}
export const layer = Layer.effect(
  MeshStateBackup,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lock = yield* Semaphore.make(1);
    const root = path.join(config.baseDir, "runtime/mesh-backup");
    const prune = Effect.fn("MeshStateBackup.prune")(function* (current: string) {
      const now = yield* Clock.currentTimeMillis;
      const snapshots: { directory: string; modified: number }[] = [];
      for (const name of yield* fs.readDirectory(root)) {
        const directory = path.join(root, name);
        const info = yield* fs.stat(directory);
        if (info.type !== "Directory") continue;
        const modified = Option.match(info.mtime, {
          onNone: () => 0,
          onSome: (time) => time.getTime(),
        });
        const destination = path.join(directory, "statev2.sqlite");
        if (yield* fs.exists(destination)) {
          snapshots.push({ directory, modified });
          yield* fs.remove(destination + ".tmp", { force: true });
        } else if (directory !== current && now - modified > 24 * 60 * 60 * 1000) {
          yield* fs.remove(directory, { recursive: true });
        }
      }
      snapshots.sort(
        (a, b) =>
          Number(b.directory === current) - Number(a.directory === current) ||
          b.modified - a.modified ||
          (a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0),
      );
      for (const snapshot of snapshots.slice(10))
        yield* fs.remove(snapshot.directory, { recursive: true });
    });
    return MeshStateBackup.of({
      create: Effect.fn("MeshStateBackup.create")(
        function* (token) {
          const directory = path.join(
            config.baseDir,
            "runtime/mesh-backup",
            encodeURIComponent(token),
          );
          const destination = path.join(directory, "statev2.sqlite");
          if (yield* fs.exists(destination)) {
            yield* prune(directory);
            return;
          }
          yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
          yield* fs.remove(destination + ".tmp", { force: true });
          yield* Effect.tryPromise(async () => {
            const database = new NodeSqlite.DatabaseSync(config.dbPath, { readOnly: true });
            try {
              await NodeSqlite.backup(database, destination + ".tmp");
            } finally {
              database.close();
            }
          });
          yield* fs.rename(destination + ".tmp", destination);
          yield* prune(directory);
        },
        lock.withPermits(1),
        Effect.tapError((cause) => Effect.logError("Mesh state backup failed", cause)),
        Effect.mapError(
          () =>
            new MeshConfigError({
              reason: "storage",
              message: "State DB backup failed before downloading the update",
            }),
        ),
      ),
    });
  }),
);
