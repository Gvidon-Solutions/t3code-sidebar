import { conflictMtimeScript } from "./conflictMtimeScript.ts";
import { replicaIgnorePatterns } from "./replicaModel.ts";
import { replicaManifestScript } from "./replicaManifestScript.ts";
import {
  preserveConflictScript,
  nodeCommand,
  sshArguments,
  mutagenSshEnvironment,
} from "../platform/ServerPlatform.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ReplicaError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import * as MutagenInstaller from "./MutagenInstaller.ts";

const Problem = Schema.Struct({ path: Schema.String, error: Schema.String });
const Endpoint = Schema.Struct({
  path: Schema.String,
  protocol: Schema.optionalKey(Schema.String),
  host: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Number),
  connected: Schema.optionalKey(Schema.Boolean),
  scanProblems: Schema.optionalKey(Schema.Array(Problem)),
  excludedScanProblems: Schema.optionalKey(Schema.Number),
  transitionProblems: Schema.optionalKey(Schema.Array(Problem)),
  excludedTransitionProblems: Schema.optionalKey(Schema.Number),
  stagingProgress: Schema.optionalKey(
    Schema.Struct({
      receivedSize: Schema.Number,
      expectedSize: Schema.Number,
      receivedFiles: Schema.Number,
      expectedFiles: Schema.Number,
    }),
  ),
});
export const MutagenSession = Schema.Struct({
  identifier: Schema.String,
  ignore: Schema.optionalKey(
    Schema.Struct({ paths: Schema.optionalKey(Schema.Array(Schema.String)) }),
  ),
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

export interface ReplicaEndpoint {
  readonly path: string;
  readonly environmentId: string;
  readonly route?: { readonly ssh: string; readonly identityFile?: string };
}
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
    readonly changedPaths: (input: {
      readonly source: ReplicaEndpoint;
      readonly destination: ReplicaEndpoint;
      readonly ignores: readonly string[];
    }) => Effect.Effect<readonly string[], ReplicaError>;
    readonly assertReplicaPath: (input: {
      readonly source: ReplicaEndpoint;
      readonly destination: ReplicaEndpoint;
      readonly ignores: readonly string[];
    }) => Effect.Effect<void, ReplicaError>;
    readonly preserveConflicts: (input: {
      readonly root: string;
      readonly paths: readonly string[];
      readonly iso: string;
      readonly route?: { readonly ssh: string; readonly identityFile?: string };
      readonly environmentId: string;
    }) => Effect.Effect<void, ReplicaError>;
    readonly conflictMtime: (input: {
      readonly root: string;
      readonly paths: readonly string[];
      readonly route?: { readonly ssh: string; readonly identityFile?: string };
      readonly environmentId: string;
    }) => Effect.Effect<number, ReplicaError>;
    readonly create: (input: CreateSession) => Effect.Effect<void, ReplicaError>;
    readonly list: (
      selector?: string,
    ) => Effect.Effect<ReadonlyArray<MutagenSession>, ReplicaError>;
    readonly foreignList: Effect.Effect<ReadonlyArray<MutagenSession>, ReplicaError>;
    readonly foreignAction: (
      action: "pause" | "terminate",
      session: string,
    ) => Effect.Effect<void, ReplicaError>;
    readonly listExisting: Effect.Effect<ReadonlyArray<MutagenSession>, ReplicaError>;
    readonly flush: (session: string) => Effect.Effect<void, ReplicaError>;
    readonly pause: (session: string) => Effect.Effect<void, ReplicaError>;
    readonly resume: (session: string) => Effect.Effect<void, ReplicaError>;
    readonly reset: (session: string) => Effect.Effect<void, ReplicaError>;
    readonly terminate: (session: string) => Effect.Effect<void, ReplicaError>;
    readonly daemon: (action: "start" | "stop") => Effect.Effect<void, ReplicaError>;
  }
>()("t3/replicas/MutagenRunner") {}

const isReplicaError = Schema.is(ReplicaError);
const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const encodeIgnores = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      entries: Schema.Number,
      hash: Schema.String,
      files: Schema.Record(Schema.String, Schema.String),
    }),
  ),
);

const make = Effect.gen(function* () {
  const installer = yield* MutagenInstaller.MutagenInstaller;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const run = Effect.fn("MutagenRunner.run")(function* (
    args: ReadonlyArray<string>,
    foreign = false,
  ) {
    const command = yield* installer.executable;
    const result = yield* runner
      .run({
        command,
        args,
        env: {
          ...process.env,
          MUTAGEN_DATA_DIRECTORY: foreign ? undefined : installer.dataDirectory,
          ...(!foreign
            ? mutagenSshEnvironment(platform, environment.T3_MESH_SSH_HOME, installer.dataDirectory)
            : {}),
        },
        timeout: "60 seconds",
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
  const list = Effect.fn("MutagenRunner.list")((selector = "t3-logical") =>
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
  );
  const manifest = Effect.fn("MutagenRunner.manifest")(function* (
    endpoint: ReplicaEndpoint,
    ignores: readonly string[],
  ) {
    const encodedIgnores = yield* encodeIgnores(ignores).pipe(
      Effect.mapError(
        (cause) =>
          new ReplicaError({
            reason: "storage",
            message: "Invalid replica ignore patterns.",
            cause,
          }),
      ),
    );
    const pathJson = encodeString(endpoint.path);
    const ignoresJson = encodeString(encodedIgnores);
    const source = `process.argv = ['node', ${pathJson}, ${ignoresJson}];\n${replicaManifestScript}`;
    const args = ["-e", source];
    const route = endpoint.route;
    const result = yield* runner
      .run({
        command: route ? "ssh" : "node",
        args: route
          ? [...sshArguments(route.ssh, environment.T3_MESH_SSH_HOME), nodeCommand(source)]
          : args,
        timeout: "60 seconds",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ReplicaError({
              reason: "storage",
              message: "Cannot compare the requested replica folder with its primary.",
              cause,
            }),
        ),
      );
    if (result.code !== 0 || result.stdoutTruncated)
      return yield* new ReplicaError({
        reason: "storage",
        message:
          "Cannot compare the requested replica folder with its primary. Check folder access and Node.js over SSH.",
        cause: result,
      });
    return yield* decodeManifest(result.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new ReplicaError({
            reason: "storage",
            message: "Invalid folder comparison result.",
            cause,
          }),
      ),
    );
  });
  return MutagenRunner.of({
    foreignList: run(["sync", "list", "--template", "{{json .}}"], true).pipe(
      Effect.flatMap(decodeSessions),
      Effect.mapError((cause) =>
        isReplicaError(cause)
          ? cause
          : new ReplicaError({
              reason: "mutagen",
              message: "Cannot read existing Mutagen sessions.",
              cause,
            }),
      ),
    ),
    foreignAction: Effect.fn("MutagenRunner.foreignAction")((action, session) =>
      run(["sync", action, session], true).pipe(Effect.asVoid),
    ),
    changedPaths: Effect.fn("MutagenRunner.changedPaths")(function* (input) {
      const [alpha, beta] = yield* Effect.all(
        [manifest(input.source, input.ignores), manifest(input.destination, input.ignores)],
        { concurrency: 2 },
      );
      return [...new Set([...Object.keys(alpha.files), ...Object.keys(beta.files)])]
        .filter((file) => alpha.files[file] !== beta.files[file])
        .sort();
    }),
    assertReplicaPath: Effect.fn("MutagenRunner.assertReplicaPath")(function* (input) {
      const destination = yield* manifest(input.destination, input.ignores);
      if (destination.entries === 0) return;
      const source = yield* manifest(input.source, input.ignores);
      if (destination.hash !== source.hash)
        return yield* new ReplicaError({
          reason: "storage",
          message:
            "The requested replica folder is not empty and differs from the primary. Choose an empty folder or adopt its existing sync session.",
        });
    }),
    preserveConflicts: Effect.fn("MutagenRunner.preserveConflicts")(function* (input) {
      const script = yield* Effect.try({
        try: () => preserveConflictScript(input.root, input.iso, input.paths),
        catch: (cause) =>
          new ReplicaError({ reason: "storage", message: "Unsafe conflict copy path.", cause }),
      });
      const route = input.route;
      const result = yield* runner
        .run({
          command: route ? "ssh" : "node",
          args: route
            ? [...sshArguments(route.ssh, environment.T3_MESH_SSH_HOME), nodeCommand(script)]
            : ["-e", script],
          timeout: "60 seconds",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReplicaError({
                reason: "storage",
                message: "Cannot preserve losing conflict versions.",
                cause,
              }),
          ),
        );
      if (result.code !== 0)
        return yield* new ReplicaError({
          reason: "storage",
          message: "Cannot preserve losing conflict versions.",
          cause: result,
        });
    }),
    conflictMtime: Effect.fn("MutagenRunner.conflictMtime")(function* (input) {
      const source = yield* Effect.try({
        try: () => conflictMtimeScript(input.root, input.paths),
        catch: (cause) =>
          new ReplicaError({ reason: "storage", message: "Unsafe conflict path.", cause }),
      });
      const route = input.route;
      const result = yield* runner
        .run({
          command: route ? "ssh" : "node",
          args: route
            ? [...sshArguments(route.ssh, environment.T3_MESH_SSH_HOME), nodeCommand(source)]
            : ["-e", source],
          timeout: "30 seconds",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReplicaError({
                reason: "storage",
                message: "Cannot read conflict modification times.",
                cause,
              }),
          ),
        );
      if (result.code !== 0)
        return yield* new ReplicaError({
          reason: "storage",
          message: "Cannot read conflict modification times.",
          cause: result,
        });
      const parsed = Number(result.stdout.trim());
      if (!result.stdout.trim() || !Number.isFinite(parsed))
        return yield* new ReplicaError({
          reason: "storage",
          message: "Invalid conflict modification time.",
        });
      return parsed;
    }),
    create: Effect.fn("MutagenRunner.create")((input) =>
      run([
        "sync",
        "create",
        "--no-global-configuration",
        "--mode",
        "two-way-safe",
        "--ignore-vcs",
        ...replicaIgnorePatterns(input.ignores).flatMap((ignore) => ["-i", ignore]),
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
    list,
    listExisting: fs.exists(installer.dataDirectory).pipe(
      Effect.flatMap((exists) => (exists ? list() : Effect.succeed([]))),
      Effect.mapError((cause) =>
        isReplicaError(cause)
          ? cause
          : new ReplicaError({
              reason: "storage",
              message: "Cannot inspect private Mutagen state.",
              cause,
            }),
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
