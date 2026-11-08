import { cliReleaseDownloadBaseUrl } from "@t3tools/shared/cliRelease";
import { MeshConfigError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { meshServicePlan } from "../platform/ServerPlatform.ts";
import { ProcessRunner } from "../processRunner.ts";
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const decodeSettings = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);
export const InstallInput = Schema.Struct({
  version: Schema.String,
  releaseBaseUrl: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^https:\/\/[^\r\n]+$/))),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  baseDir: Schema.optionalKey(Schema.String),
  listenHost: Schema.optionalKey(Schema.Literals(["127.0.0.1", "::1", "0.0.0.0", "::"])),
});
export class MeshInstall extends Context.Service<
  MeshInstall,
  {
    readonly install: (
      input: typeof InstallInput.Type,
    ) => Effect.Effect<{ baseDir: string }, MeshConfigError>;
  }
>()("t3/mesh/MeshInstall") {}
export const layer = Layer.effect(
  MeshInstall,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    const uid = yield* HostProcess.UserId;
    const user = yield* HostProcess.Username;
    const executable = yield* HostProcess.ExecutablePath;
    const runner = yield* ProcessRunner;
    const install = Effect.fn("MeshInstall.install")(
      function* (input: typeof InstallInput.Type) {
        if (platform !== "linux" && platform !== "darwin" && platform !== "win32")
          return yield* new MeshConfigError({
            reason: "validation",
            message: "Unsupported service platform",
          });
        yield* Effect.try(() => cliReleaseDownloadBaseUrl(input.version, input.releaseBaseUrl));
        const baseDir = input.baseDir ?? path.join(home, ".t3-mesh");
        if (!path.isAbsolute(baseDir))
          return yield* new MeshConfigError({
            reason: "validation",
            message: "Bootstrap base directory must be absolute",
          });
        yield* fs.makeDirectory(path.join(baseDir, "runtime"), { recursive: true, mode: 0o700 });
        const stateFile = path.join(baseDir, "runtime/service-state.json");
        if (!(yield* fs.exists(stateFile)))
          yield* fs.writeFileString(
            stateFile,
            yield* encodeJson({
              protocol: 3,
              activeVersion: input.version,
            }),
          );
        yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true, mode: 0o700 });
        const settingsFile = path.join(baseDir, "userdata/settings.json");
        const settings = (yield* fs.exists(settingsFile))
          ? yield* decodeSettings(yield* fs.readFileString(settingsFile))
          : {};
        yield* fs.writeFileString(
          settingsFile,
          yield* encodeJson({
            ...settings,
            linkedEnvironmentsEnabled: true,
            meshEnabled: true,
            replicasEnabled: true,
          }),
        );
        yield* fs.writeFileString(
          path.join(baseDir, "service.env"),
          `T3CODE_HOST=${input.listenHost ?? "127.0.0.1"}\nT3CODE_PORT=${input.port}\nT3CODE_NO_BROWSER=true\nT3_MESH_JOINING=1\n${input.releaseBaseUrl ? `T3CODE_RELEASE_BASE_URL=${input.releaseBaseUrl}\n` : ""}`,
        );
        const plan = meshServicePlan({
          platform,
          home,
          baseDir,
          executable,
          uid: uid ?? 0,
          user: user ?? "",
        });
        for (const file of plan.files) {
          yield* fs.makeDirectory(path.dirname(file.path), { recursive: true });
          yield* fs.writeFileString(file.path, file.content);
        }
        for (const command of plan.commands) {
          if ("skipIfAccepted" in command && command.skipIfAccepted) {
            const exists = yield* runner.run({ ...command.skipIfAccepted, timeout: "10 seconds" });
            if (exists.code === 0) continue;
          }
          const result = yield* runner.run({
            command: command.command,
            args: command.args,
            timeout: "2 minutes",
          });
          if (result.code !== 0)
            return yield* new MeshConfigError({
              reason: "storage",
              message: `Service manager ${command.command} failed (exit ${result.code})`,
            });
        }
        return { baseDir };
      },
      Effect.mapError((error) =>
        error._tag === "MeshConfigError"
          ? error
          : new MeshConfigError({ reason: "storage", message: "Cannot install mesh service" }),
      ),
    );
    return MeshInstall.of({ install });
  }),
);
