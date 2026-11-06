import {
  ForkBundle,
  ProjectId,
  ThreadForkResult,
  RuntimeMode,
  ProviderInteractionMode,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import { ServerConfig } from "../config.ts";

const ForkLimits = Schema.Struct({
  replicas: Schema.optionalKey(Schema.Boolean),
  files: Schema.optionalKey(Schema.Literals(["all", "projects", "none"])),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
const ForkTransaction = Schema.Union([
  Schema.Struct({
    phase: Schema.Literal("uploading"),
    forkId: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    phase: Schema.Literals(["pending", "committing"]),
    token: Schema.String,
    expiresAt: Schema.Number,
    bundle: ForkBundle,
    projectId: ProjectId,
    claimedPaths: Schema.Array(Schema.String),
    limits: ForkLimits,
  }),
  Schema.Struct({
    phase: Schema.Literal("committed"),
    token: Schema.String,
    result: ThreadForkResult,
  }),
  Schema.Struct({
    phase: Schema.Literal("outgoing"),
    token: Schema.String,
    forkId: Schema.String,
    targetEnvironmentId: EnvironmentId,
    sourceThreadId: ThreadId,
    sourceTitle: Schema.String,
    limits: ForkLimits,
  }),
]);
export type ForkTransaction = typeof ForkTransaction.Type;

class ForkTransactionError extends Schema.TaggedError<ForkTransactionError>()(
  "ForkTransactionError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Fork transaction storage failed.";
  }
}

export class ForkTransactions extends Context.Service<
  ForkTransactions,
  {
    readonly read: (
      key: string,
    ) => Effect.Effect<ForkTransaction | undefined, ForkTransactionError>;
    readonly write: (
      key: string,
      value: ForkTransaction,
    ) => Effect.Effect<void, ForkTransactionError>;
    readonly remove: (key: string) => Effect.Effect<void, ForkTransactionError>;
    readonly list: Effect.Effect<
      ReadonlyArray<{ key: string; value: ForkTransaction }>,
      ForkTransactionError
    >;
  }
>()("t3/mesh/ForkTransactions") {}

export const layer = Layer.effect(
  ForkTransactions,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const digest = yield* Digest.Digest;
    const config = yield* ServerConfig;
    const root = path.join(config.stateDir, "fork-transactions");
    const decode = Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ key: Schema.String, value: ForkTransaction })),
    );
    const encode = Schema.encodeEffect(
      Schema.fromJsonString(Schema.Struct({ key: Schema.String, value: ForkTransaction })),
    );
    const storageError = (cause: unknown) => new ForkTransactionError({ cause });
    const fileFor = Effect.fn("ForkTransactions.fileFor")(function* (key: string) {
      const hash = yield* digest
        .digest(Digest.sha256, new TextEncoder().encode(key))
        .pipe(Effect.mapError(storageError));
      return path.join(root, `${Hex.encode(hash)}.json`);
    });
    const read = Effect.fn("ForkTransactions.read")(function* (key: string) {
      const file = yield* fileFor(key);
      if (!(yield* fs.exists(file).pipe(Effect.mapError(storageError)))) return undefined;
      return (yield* fs
        .readFileString(file)
        .pipe(Effect.flatMap(decode), Effect.mapError(storageError))).value;
    });
    const write = Effect.fn("ForkTransactions.write")(function* (
      key: string,
      value: ForkTransaction,
    ) {
      const file = yield* fileFor(key);
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.mapError(storageError));
      // Rename prevents a crash from turning a durable lease or commit intent into partial JSON.
      yield* fs
        .writeFileString(
          `${file}.tmp`,
          yield* encode({ key, value }).pipe(Effect.mapError(storageError)),
        )
        .pipe(Effect.mapError(storageError));
      yield* fs.rename(`${file}.tmp`, file).pipe(Effect.mapError(storageError));
    });
    const remove = Effect.fn("ForkTransactions.remove")(function* (key: string) {
      yield* fs.remove(yield* fileFor(key), { force: true }).pipe(Effect.mapError(storageError));
    });
    const list = Effect.gen(function* () {
      if (!(yield* fs.exists(root).pipe(Effect.mapError(storageError)))) return [];
      const files = yield* fs.readDirectory(root).pipe(Effect.mapError(storageError));
      return yield* Effect.forEach(
        files.filter((file) => file.endsWith(".json")),
        (file) =>
          fs
            .readFileString(path.join(root, file))
            .pipe(Effect.flatMap(decode), Effect.mapError(storageError)),
      );
    });
    return ForkTransactions.of({ read, write, remove, list });
  }),
);
