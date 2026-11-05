// @effect-diagnostics nodeBuiltinImport:off -- SQLite's online backup API creates a consistent pre-download snapshot while the server is running.
import * as NodeSqlite from "node:sqlite";
import { MeshConfigError } from "@t3tools/contracts";
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
    return MeshStateBackup.of({
      create: Effect.fn("MeshStateBackup.create")(
        function* (token) {
          const directory = path.join(
            config.baseDir,
            "runtime/mesh-backup",
            encodeURIComponent(token),
          );
          const destination = path.join(directory, "statev2.sqlite");
          if (yield* fs.exists(destination)) return;
          yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
          yield* Effect.tryPromise(async () => {
            const database = new NodeSqlite.DatabaseSync(config.dbPath, { readOnly: true });
            try {
              await NodeSqlite.backup(database, destination + ".tmp");
            } finally {
              database.close();
            }
          });
          yield* fs.rename(destination + ".tmp", destination);
        },
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
