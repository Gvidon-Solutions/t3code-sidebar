import { downloadVerified } from "../platform/Download.ts";
import { MeshConfigError } from "@t3tools/contracts";
import {
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliReleaseDownloadBaseUrl,
} from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Digest from "effect/crypto/Digest";

import { HttpClient } from "effect/http";
export class MeshRuntimeArchive extends Context.Service<
  MeshRuntimeArchive,
  {
    readonly download: (
      version: string,
      platform: NodeJS.Platform,
      arch: string,
      expectedSha256: string | undefined,
      report?: (stage: "download" | "verify") => Effect.Effect<void, MeshConfigError>,
    ) => Effect.Effect<Uint8Array, MeshConfigError>;
  }
>()("t3/mesh/MeshRuntimeArchive") {}
export const layer = Layer.effect(
  MeshRuntimeArchive,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const digest = yield* Digest.Digest;
    const env = yield* HostProcess.Environment;
    const download = Effect.fn("MeshRuntimeArchive.download")(
      function* (
        version: string,
        platform: NodeJS.Platform,
        arch: string,
        expected: string | undefined,
        report: (stage: "download" | "verify") => Effect.Effect<void, MeshConfigError> = () =>
          Effect.void,
      ) {
        yield* report("download");
        if (!/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(version))
          return yield* new MeshConfigError({
            reason: "validation",
            message: "An exact runtime version is required",
          });
        const key = cliArchivePlatformKey(platform, arch);
        if (!key)
          return yield* new MeshConfigError({
            reason: "validation",
            message: `Unsupported runtime platform: ${platform}/${arch}`,
          });
        const base = cliReleaseDownloadBaseUrl(version, env.T3CODE_RELEASE_BASE_URL);
        const filename = cliArchiveFileName(version, key);
        if (!expected || !/^[a-f0-9]{64}$/i.test(expected))
          return yield* new MeshConfigError({
            reason: "validation",
            message: `Pin t3.runtimeChecksums[${filename}] in mesh config before downloading`,
          });
        return yield* downloadVerified(http, `${base}/${filename}`, expected, {
          stallTimeout: "10 minutes",
          onVerify: report("verify"),
        }).pipe(Effect.provideService(Digest.Digest, digest));
      },
      Effect.timeout("10 minutes"),
      Effect.mapError((error) =>
        error._tag === "MeshConfigError"
          ? error
          : new MeshConfigError({
              reason: "storage",
              message:
                error._tag === "DownloadError" && error.reason === "checksum"
                  ? `Runtime SHA-256 verification failed: ${error.message}`
                  : "Runtime download failed or timed out",
            }),
      ),
    );
    return MeshRuntimeArchive.of({ download });
  }),
);
