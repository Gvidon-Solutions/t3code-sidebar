import { virtualEnvironmentPython } from "../platform/ServerPlatform.ts";
import { ReplicaError } from "@t3tools/contracts";
import { meshRetryDelay } from "../mesh/retryBackoff.ts";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";

const Failure = Schema.Struct({
  fingerprint: Schema.String,
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  retryAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const decodeFailure = Schema.decodeEffect(Schema.fromJsonString(Failure));
const encodeFailure = Schema.encodeEffect(Schema.fromJsonString(Failure));

const locks = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "uv.lock",
  "requirements.txt",
  "requirements.lock",
  "pylock.toml",
  "Cargo.lock",
  "go.sum",
];
export function environmentCommands(files: readonly string[], platform: string) {
  const found = new Set(files);
  const commands: { command: string; args: string[] }[] = [];
  if (found.has("pnpm-lock.yaml"))
    commands.push({ command: "pnpm", args: ["install", "--frozen-lockfile"] });
  else if (found.has("package-lock.json") || found.has("npm-shrinkwrap.json"))
    commands.push({ command: "npm", args: ["ci"] });
  else if (found.has("yarn.lock"))
    commands.push({ command: "yarn", args: ["install", "--frozen-lockfile"] });
  else if (found.has("bun.lock") || found.has("bun.lockb"))
    commands.push({ command: "bun", args: ["install", "--frozen-lockfile"] });
  if (found.has("uv.lock")) commands.push({ command: "uv", args: ["sync", "--frozen"] });
  else {
    const requirements = ["requirements.lock", "pylock.toml", "requirements.txt"].find((file) =>
      found.has(file),
    );
    if (requirements)
      commands.push(
        { command: "uv", args: ["venv", ".venv"] },
        {
          command: "uv",
          args: ["pip", "sync", "--python", virtualEnvironmentPython(platform), requirements],
        },
      );
  }
  if (found.has("Cargo.lock")) commands.push({ command: "cargo", args: ["fetch", "--locked"] });
  if (found.has("go.sum")) commands.push({ command: "go", args: ["mod", "download"] });
  return commands;
}
export class ReplicaEnvironment extends Context.Service<
  ReplicaEnvironment,
  {
    readonly retry: (root: string) => Effect.Effect<void, ReplicaError>;
    readonly ensure: (
      root: string,
      report: (
        state: "installing" | "ready" | "failed",
        reason?: string,
      ) => Effect.Effect<void, ReplicaError>,
    ) => Effect.Effect<void, ReplicaError>;
  }
>()("t3/replicas/ReplicaEnvironment") {}
export const layer = Layer.effect(
  ReplicaEnvironment,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const digest = yield* Digest.Digest;
    const platform = yield* HostProcess.Platform;
    const processes = yield* ProcessRunner.ProcessRunner;
    return ReplicaEnvironment.of({
      retry: Effect.fn("ReplicaEnvironment.retry")((root) =>
        fs.remove(path.join(root, ".t3", "environment.failed"), { force: true }).pipe(
          Effect.mapError(
            (cause) =>
              new ReplicaError({
                reason: "storage",
                message: "Cannot reset the failed environment fingerprint.",
                cause,
              }),
          ),
        ),
      ),
      ensure: Effect.fn("ReplicaEnvironment.ensure")(
        function* (root, report) {
          const chunks: Uint8Array[] = [];
          const files: string[] = [];
          for (const file of locks) {
            const absolute = path.join(root, file);
            if (!(yield* fs.exists(absolute))) continue;
            files.push(file);
            chunks.push(
              new TextEncoder().encode(file + "\0"),
              yield* fs.readFile(absolute),
              new Uint8Array([0]),
            );
          }
          const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          const fingerprint = Hex.encode(yield* digest.digest(Digest.sha256, bytes));
          const marker = path.join(root, ".t3", "environment.sha256");
          const failed = path.join(root, ".t3", "environment.failed");
          if (yield* fs.exists(marker)) {
            if ((yield* fs.readFileString(marker)) === fingerprint) {
              yield* report("ready");
              return;
            }
          }
          const prior = (yield* fs.exists(failed))
            ? yield* decodeFailure(yield* fs.readFileString(failed))
            : undefined;
          const attempts = prior?.fingerprint === fingerprint ? prior.attempts : 0;
          if (attempts >= 3)
            return yield* new ReplicaError({
              reason: "storage",
              message:
                "Environment installation exhausted three attempts for this lock fingerprint. Retry explicitly or update the lockfile.",
            });
          if (
            prior?.fingerprint === fingerprint &&
            (yield* Clock.currentTimeMillis) < prior.retryAt
          )
            return yield* new ReplicaError({
              reason: "storage",
              message:
                "Environment installation is waiting for its retry backoff. Retry explicitly or update the lockfile.",
            });
          const commands = environmentCommands(files, platform);
          if (!commands.length) {
            yield* report("ready");
            return;
          }
          if (commands.length) yield* report("installing");
          yield* Effect.gen(function* () {
            for (const { command, args } of commands) {
              const result = yield* processes.run({
                command,
                args,
                cwd: root,
                timeout: "10 minutes",
                maxOutputBytes: 1024 * 1024,
                outputMode: "truncate",
              });
              if (result.code !== 0)
                return yield* new ReplicaError({
                  reason: "storage",
                  message: `Environment install failed: ${command} exited ${result.code}; ${result.stderr.trim().slice(-1000)}`,
                });
            }
          }).pipe(
            Effect.tapError(() =>
              Effect.gen(function* () {
                yield* fs.makeDirectory(path.dirname(failed), { recursive: true });
                yield* fs.writeFileString(
                  failed,
                  yield* encodeFailure({
                    fingerprint,
                    attempts: attempts + 1,
                    retryAt:
                      (yield* Clock.currentTimeMillis) +
                      meshRetryDelay(attempts, 1, { initialMs: 60000, maxMs: 15 * 60000 }),
                  }),
                );
              }),
            ),
          );
          yield* fs.makeDirectory(path.dirname(marker), { recursive: true });
          yield* fs.writeFileString(marker, fingerprint);
          yield* fs.remove(failed, { force: true });
          yield* report("ready");
        },
        Effect.mapError(
          (cause) =>
            new ReplicaError({
              reason: "storage",
              message: `environment: failed: ${cause.message}`,
              cause,
            }),
        ),
      ),
    });
  }),
);
