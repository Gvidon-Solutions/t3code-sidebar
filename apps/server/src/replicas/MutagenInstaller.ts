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

// https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/SHA256SUMS
const checksums: Readonly<Record<string, string>> = {
  linux_amd64: "7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f",
  linux_arm64: "bcba735aebf8cbc11da9b3742118a665599ac697fa06bc5751cac8dcd540db8a",
  darwin_amd64: "7d06f7d8fcfe90bc7e55cc834a2f2f20c2e0af9ea9bc35911fc4341ad56a9bbf",
  darwin_arm64: "6f810416d9e5fc4fd5e18431146f8b3c5a2056ba5a24f76c1e66da86eb3257e2",
  windows_amd64: "3e237e77f69959ed520a0f877330a431507bb0a85d9da7919764ba0c87b702c7",
  windows_arm64: "9ac53447e46f019be9d37f49c00eeed8635966b885ed29ef06b3ff19afdee532",
};
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
  const executable = join(bin, platformName === "win32" ? "mutagen.exe" : "mutagen");
  const install = Effect.fn("MutagenInstaller.install")(function* () {
    const override = (yield* settings.getSettings).mutagenPath;
    if (override) return override;
    if ((yield* fs.exists(executable)) && (yield* fs.exists(join(bin, "mutagen-agents.tar.gz"))))
      return executable;
    const platform = platformName === "win32" ? "windows" : platformName;
    const arch = architecture === "x64" ? "amd64" : architecture;
    const target = `${platform}_${arch}`;
    const checksum = checksums[target];
    if (!checksum)
      return yield* new ReplicaError({
        reason: "mutagen",
        message: `Mutagen does not support ${target}.`,
      });
    const archive = `mutagen_${target}_v0.18.1.tar.gz`;
    const response = yield* http.get(
      `https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/${archive}`,
    );
    if (response.status !== 200)
      return yield* new ReplicaError({ reason: "mutagen", message: "Mutagen download failed." });
    const bytes = new Uint8Array(yield* response.arrayBuffer);
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
    yield* fs.copyFile(
      join(staging, platformName === "win32" ? "mutagen.exe" : "mutagen"),
      `${executable}.tmp`,
    );
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
