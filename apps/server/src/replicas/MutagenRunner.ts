import { ReplicaError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import * as MutagenInstaller from "./MutagenInstaller.ts";

const Problem = Schema.Struct({ path: Schema.String, error: Schema.String });
const Endpoint = Schema.Struct({
  path: Schema.String,
  connected: Schema.optionalKey(Schema.Boolean),
  scanProblems: Schema.optionalKey(Schema.Array(Problem)),
  transitionProblems: Schema.optionalKey(Schema.Array(Problem)),
  stagingProgress: Schema.optionalKey(
    Schema.Struct({
      receivedSize: Schema.Number,
      totalSize: Schema.Number,
    }),
  ),
});
export const MutagenSession = Schema.Struct({
  identifier: Schema.String,
  name: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  paused: Schema.Boolean,
  status: Schema.String,
  lastError: Schema.optionalKey(Schema.String),
  alpha: Endpoint,
  beta: Endpoint,
  conflicts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        root: Schema.String,
      }),
    ),
  ),
});
export type MutagenSession = typeof MutagenSession.Type;
export const decodeSessions = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(MutagenSession)),
);

export interface CreateSession {
  readonly name: string;
  readonly logicalHash: string;
  readonly environmentTag: string;
  readonly alpha: string;
  readonly beta: string;
  readonly ignores: ReadonlyArray<string>;
}
export class MutagenRunner extends Context.Service<
  MutagenRunner,
  {
    readonly create: (input: CreateSession) => Effect.Effect<void, ReplicaError>;
    readonly list: (
      selector?: string,
    ) => Effect.Effect<ReadonlyArray<MutagenSession>, ReplicaError>;
    readonly flush: (session: string) => Effect.Effect<void, ReplicaError>;
    readonly pause: (session: string) => Effect.Effect<void, ReplicaError>;
    readonly resume: (session: string) => Effect.Effect<void, ReplicaError>;
    readonly reset: (session: string) => Effect.Effect<void, ReplicaError>;
    readonly terminate: (session: string) => Effect.Effect<void, ReplicaError>;
    readonly daemon: (action: "start" | "stop") => Effect.Effect<void, ReplicaError>;
  }
>()("t3/replicas/MutagenRunner") {}

const isReplicaError = Schema.is(ReplicaError);

const make = Effect.gen(function* () {
  const installer = yield* MutagenInstaller.MutagenInstaller;
  const runner = yield* ProcessRunner.ProcessRunner;
  const run = Effect.fn("MutagenRunner.run")(function* (args: ReadonlyArray<string>) {
    const command = yield* installer.executable;
    const result = yield* runner
      .run({
        command,
        args,
        env: { ...process.env, MUTAGEN_DATA_DIRECTORY: installer.dataDirectory },
        timeout: "10 minutes",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ReplicaError({ reason: "mutagen", message: "Mutagen process failed.", cause }),
        ),
      );
    if (result.code !== 0)
      return yield* new ReplicaError({
        reason: "mutagen",
        message: "Mutagen command failed.",
        cause: result,
      });
    return result.stdout;
  });
  const action = (verb: string) => (session: string) =>
    run(["sync", verb, session]).pipe(Effect.asVoid);
  return MutagenRunner.of({
    create: Effect.fn("MutagenRunner.create")((input) =>
      run([
        "sync",
        "create",
        "--mode",
        "two-way-safe",
        "--ignore-vcs",
        ...input.ignores.flatMap((ignore) => ["-i", ignore]),
        "--default-file-mode-beta=0644",
        "--default-directory-mode-beta=0755",
        "--symlink-mode=portable",
        "-l",
        `t3-logical=${input.logicalHash}`,
        "-l",
        `t3-env=${input.environmentTag}`,
        "--name",
        input.name,
        input.alpha,
        input.beta,
      ]).pipe(Effect.asVoid),
    ),
    list: Effect.fn("MutagenRunner.list")((selector = "t3-logical") =>
      run(["sync", "list", "--label-selector", selector, "--template", "{{json .}}"]).pipe(
        Effect.flatMap(decodeSessions),
        Effect.mapError((cause) =>
          isReplicaError(cause)
            ? cause
            : new ReplicaError({
                reason: "mutagen",
                message: "Invalid Mutagen session output.",
                cause,
              }),
        ),
      ),
    ),
    flush: action("flush"),
    pause: action("pause"),
    resume: action("resume"),
    reset: action("reset"),
    terminate: action("terminate"),
    daemon: Effect.fn("MutagenRunner.daemon")((verb) => run(["daemon", verb]).pipe(Effect.asVoid)),
  });
});
export const layer = Layer.effect(MutagenRunner, make);
