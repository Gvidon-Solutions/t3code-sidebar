import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Digest from "effect/crypto/Digest";
import { HttpClient, HttpClientResponse } from "effect/http";
import { downloadVerified } from "./Download.ts";

it.effect("requires a pinned digest and releases only matching bytes", () =>
  Effect.gen(function* () {
    let requests = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests++;
        return HttpClientResponse.fromWeb(request, new Response("abc"));
      }),
    );
    const invalid = yield* downloadVerified(
      http,
      "https://example.test/archive",
      "not-a-digest",
    ).pipe(Effect.flip);
    expect(invalid.reason).toBe("checksum");
    expect(requests).toBe(0);
    const mismatch = yield* downloadVerified(
      http,
      "https://example.test/archive",
      "0".repeat(64),
    ).pipe(Effect.flip);
    expect(mismatch.reason).toBe("checksum");
    const bytes = yield* downloadVerified(
      http,
      "https://example.test/archive",
      "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD",
    );
    expect(new TextDecoder().decode(bytes)).toBe("abc");
  }).pipe(Effect.provide(Digest.layerWebCrypto)),
);
