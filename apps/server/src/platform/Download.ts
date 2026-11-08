import * as Digest from "effect/crypto/Digest";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

export class DownloadError extends Schema.TaggedError<DownloadError>()("DownloadError", {
  reason: Schema.Literals(["download", "checksum", "timeout"]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
export type DownloadProgress = {
  readonly stage: "download";
  readonly received: number;
  readonly total: number | undefined;
};
export const downloadBytes = Effect.fn("Download.bytes")(
  function* (
    http: HttpClient.HttpClient,
    url: string,
    options: {
      readonly stallTimeout?: Duration.Input;
      readonly bodyTimeout?: Duration.Input;
      readonly onProgress?: ((progress: DownloadProgress) => void) | undefined;
    } = {},
  ) {
    const timeout = options.stallTimeout ?? "30 seconds";
    const response = yield* http
      .get(url)
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.timeout(timeout));
    const length = Number(response.headers["content-length"]);
    const total = Number.isFinite(length) && length > 0 ? length : undefined;
    let received = 0;
    options.onProgress?.({ stage: "download", received, total });
    const chunks = yield* response.stream.pipe(
      Stream.timeoutOrElse({
        duration: timeout,
        orElse: () => Stream.fail(new Cause.TimeoutError()),
      }),
      Stream.tap((chunk) =>
        Effect.sync(() => {
          received += chunk.byteLength;
          options.onProgress?.({ stage: "download", received, total });
        }),
      ),
      Stream.runCollect,
      Effect.timeout(options.bodyTimeout ?? Duration.infinity),
    );
    if (total === undefined && received > 0)
      options.onProgress?.({ stage: "download", received, total: received });
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  },
  Effect.mapError(
    (cause) =>
      new DownloadError({
        reason: cause._tag === "TimeoutError" ? "timeout" : "download",
        message: "Download failed or stalled",
        cause,
      }),
  ),
);

export const downloadVerified = Effect.fn("Download.verified")(function* <E = never, R = never>(
  http: HttpClient.HttpClient,
  url: string,
  expected: string,
  options: Parameters<typeof downloadBytes>[2] & {
    readonly onVerify?: Effect.Effect<void, E, R>;
  } = {},
) {
  if (!/^[a-f0-9]{64}$/i.test(expected))
    return yield* new DownloadError({ reason: "checksum", message: "Invalid expected SHA-256" });
  const bytes = yield* downloadBytes(http, url, options);
  if (options.onVerify) yield* options.onVerify;
  const digest = yield* Digest.Digest;
  const actual = yield* digest
    .digestHex(Digest.sha256, bytes)
    .pipe(
      Effect.mapError(
        (cause) =>
          new DownloadError({ reason: "checksum", message: "SHA-256 verification failed", cause }),
      ),
    );
  if (actual !== expected.toLowerCase())
    return yield* new DownloadError({ reason: "checksum", message: "Archive checksum mismatch" });
  return bytes;
});
