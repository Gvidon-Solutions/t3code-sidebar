import {
  mutagenChecksums,
  mutagenTarget,
  mutagenArchiveName,
  mutagenReleaseUrl,
} from "../platform/mutagenRelease.ts";
import { executableName } from "../platform/ServerPlatform.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { ReplicaError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProcessRunner from "../processRunner.ts";
import { meshAssetUrl } from "../mesh/MeshTiming.ts";

export class MutagenInstaller extends Context.Service<
  MutagenInstaller,
  {
    readonly executable: Effect.Effect<string, ReplicaError>;
    readonly dataDirectory: string;
  }
>()("t3/replicas/MutagenInstaller") {}

const isReplicaError = Schema.is(ReplicaError);

const make = Effect.gen(function* () {
  const platformName = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const { join } = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const http = yield* HttpClient.HttpClient;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const lock = yield* Semaphore.make(1);
  const bin = join(baseDir, "bin");
  const executable = join(bin, executableName("mutagen", platformName));
  const install = Effect.fn("MutagenInstaller.install")(function* () {
    const override = (yield* settings.getSettings).mutagenPath;
    if (override) return override;
    if ((yield* fs.exists(executable)) && (yield* fs.exists(join(bin, "mutagen-agents.tar.gz"))))
      return executable;
    const target = mutagenTarget(platformName, architecture);
    const checksum = mutagenChecksums[target];
    if (!checksum)
      return yield* new ReplicaError({
        reason: "mutagen",
        message: `Mutagen does not support ${target}.`,
      });
    const archive = mutagenArchiveName(target);
    const response = yield* http
      .get(meshAssetUrl(mutagenReleaseUrl(target)))
      .pipe(Effect.timeout("30 seconds"));
    if (response.status !== 200)
      return yield* new ReplicaError({ reason: "mutagen", message: "Mutagen download failed." });
    const bytes = new Uint8Array(yield* response.arrayBuffer.pipe(Effect.timeout("30 seconds")));
    if ((yield* digest.digestHex(Digest.sha256, bytes)) !== checksum)
      return yield* new ReplicaError({
        reason: "mutagen",
        message: "Mutagen archive checksum mismatch.",
      });
    const staging = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mutagen-" });
    const archivePath = join(staging, archive);
    yield* fs.writeFile(archivePath, bytes);
    const result = yield* runner.run({
      command: "tar",
      timeout: "30 seconds",
      args: ["-xzf", archivePath, "-C", staging],
      env: { ...process.env, MUTAGEN_DATA_DIRECTORY: join(baseDir, "mutagen") },
    });
    if (result.code !== 0)
      return yield* new ReplicaError({
        reason: "mutagen",
        message: "Mutagen archive extraction failed.",
      });
    yield* fs.makeDirectory(bin, { recursive: true });
    // Publish the executable last so an interrupted installation is retried.
    yield* fs.copyFile(join(staging, "mutagen-agents.tar.gz"), join(bin, "mutagen-agents.tar.gz"));
    yield* fs.copyFile(join(staging, executableName("mutagen", platformName)), `${executable}.tmp`);
    yield* fs.chmod(`${executable}.tmp`, 0o755);
    yield* fs.rename(`${executable}.tmp`, executable);
    return executable;
  });
  return MutagenInstaller.of({
    dataDirectory: join(baseDir, "mutagen"),
    executable: lock.withPermit(Effect.scoped(install())).pipe(
      Effect.mapError((cause) =>
        isReplicaError(cause)
          ? cause
          : new ReplicaError({
              reason: "mutagen",
              message: "Mutagen installation failed.",
              cause,
            }),
      ),
    ),
  });
});
export const layer = Layer.effect(MutagenInstaller, make);
