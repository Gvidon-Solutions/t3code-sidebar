import * as Schema from "effect/Schema";
import { ReplicaError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Settings from "../serverSettings.ts";

export class ReplicaPaths extends Context.Service<
  ReplicaPaths,
  {
    readonly prepareExplicit: (root: string) => Effect.Effect<string, ReplicaError>;
    readonly allocate: (sourcePath: string) => Effect.Effect<string, ReplicaError>;
  }
>()("t3/replicas/ReplicaPaths") {}

const isReplicaError = Schema.is(ReplicaError);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const settings = yield* Settings.ServerSettingsService;
  const lock = yield* Semaphore.make(1);
  const reserve = Effect.fn("ReplicaPaths.reserve")(function* (candidate: string) {
    if (yield* fs.exists(candidate)) return false;
    return yield* fs.makeDirectory(candidate).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) =>
          error.reason._tag === "AlreadyExists" ||
          error.reason._tag === "PermissionDenied" ||
          error.reason._tag === "NotFound",
        () => Effect.succeed(false),
      ),
    );
  });
  return ReplicaPaths.of({
    prepareExplicit: Effect.fn("ReplicaPaths.prepareExplicit")((root) =>
      Effect.gen(function* () {
        if (!path.isAbsolute(root))
          return yield* new ReplicaError({
            reason: "storage",
            message: "The requested replica path must be absolute.",
          });
        yield* fs.makeDirectory(root, { recursive: true });
        const info = yield* fs.stat(root);
        if (info.type !== "Directory")
          return yield* new ReplicaError({
            reason: "storage",
            message: "The requested replica path is not a folder.",
          });
        return path.normalize(root);
      }).pipe(
        Effect.mapError((cause) =>
          isReplicaError(cause)
            ? cause
            : new ReplicaError({
                reason: "storage",
                message: "Cannot use the requested replica folder. Check that it is writable.",
                cause,
              }),
        ),
      ),
    ),
    allocate: Effect.fn("ReplicaPaths.allocate")((sourcePath) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            const nativeAbsolute = path.isAbsolute(sourcePath);
            if (!nativeAbsolute && !/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(sourcePath))
              return yield* new ReplicaError({
                reason: "storage",
                message: "Replica source path must be absolute.",
              });
            const writable =
              nativeAbsolute &&
              (yield* fs.access(path.dirname(sourcePath), { writable: true }).pipe(
                Effect.as(true),
                Effect.catchIf(
                  (error) =>
                    error.reason._tag === "PermissionDenied" || error.reason._tag === "NotFound",
                  () => Effect.succeed(false),
                ),
              ));
            if (writable && (yield* reserve(sourcePath))) return sourcePath;
            const rootSetting = (yield* settings.getSettings).replicaRoot;
            const root = !rootSetting
              ? path.join(home, "t3-replicas")
              : rootSetting === "~"
                ? home
                : rootSetting.startsWith("~/")
                  ? path.join(home, rootSetting.slice(2))
                  : path.resolve(rootSetting);
            yield* fs.makeDirectory(root, { recursive: true });
            const basename =
              sourcePath.replaceAll("\\", "/").replace(/\/+$/, "").split("/").at(-1) || "project";
            for (let suffix = 1; ; suffix++) {
              const candidate = path.join(root, `${basename}${suffix === 1 ? "" : `-${suffix}`}`);
              if (yield* reserve(candidate)) return candidate;
              // An existing name is a collision; a free name that cannot be reserved is a storage error.
              if (!(yield* fs.exists(candidate)))
                return yield* new ReplicaError({
                  reason: "storage",
                  message: "Replica directory is not writable.",
                });
            }
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReplicaError({
                reason: "storage",
                message: "Could not allocate replica directory.",
                cause,
              }),
          ),
        ),
    ),
  });
});
export const layer = Layer.effect(ReplicaPaths, make);
