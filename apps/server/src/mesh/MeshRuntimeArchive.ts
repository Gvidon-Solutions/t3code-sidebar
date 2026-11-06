import { MeshConfigError } from "@t3tools/contracts";
import {
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliReleaseDownloadBaseUrl,
  parseChecksums,
} from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import { HttpClient, HttpClientResponse } from "effect/http";
export class MeshRuntimeArchive extends Context.Service<
  MeshRuntimeArchive,
  {
    readonly download: (
      version: string,
      platform: NodeJS.Platform,
      arch: string,
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
        const sums = yield* http.get(`${base}/SHA256SUMS`).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((r) => r.text),
        );
        const expected = parseChecksums(sums).get(filename);
        if (!expected)
          return yield* new MeshConfigError({
            reason: "storage",
            message: "Runtime is absent from release SHA256SUMS",
          });
        const bytes = new Uint8Array(
          yield* http.get(`${base}/${filename}`).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap((r) => r.arrayBuffer),
          ),
        );
        yield* report("verify");
        const actual = Hex.encode(yield* digest.digest(Digest.sha256, bytes));
        if (actual !== expected)
          return yield* new MeshConfigError({
            reason: "storage",
            message: "Runtime SHA-256 mismatch",
          });
        return bytes;
      },
      Effect.timeout("10 minutes"),
      Effect.mapError((error) =>
        error._tag === "MeshConfigError"
          ? error
          : new MeshConfigError({
              reason: "storage",
              message: "Runtime download failed or timed out",
            }),
      ),
    );
    return MeshRuntimeArchive.of({ download });
  }),
);
