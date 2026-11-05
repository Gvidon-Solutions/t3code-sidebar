import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Archive from "./MeshRuntimeArchive.ts";

it.effect(
  "uses release checksums and refuses missing or corrupted archives before installation",
  () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode("runtime");
      const digest = Buffer.from(
        yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)),
      ).toString("hex");
      for (const checksum of [digest, "0".repeat(64), ""]) {
        const requests: string[] = [];
        const phases: string[] = [];
        const client = HttpClient.make((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                request.url.endsWith("SHA256SUMS")
                  ? `${checksum}  t3-1.2.3-linux-x64.tar.gz\n`
                  : bytes,
              ),
            ),
          );
        });
        const result = yield* Archive.MeshRuntimeArchive.pipe(
          Effect.flatMap((service) =>
            service.download("1.2.3", "linux", "x64", (stage) =>
              Effect.sync(() => {
                phases.push(stage);
              }),
            ),
          ),
          Effect.provide(Archive.layer),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(HostProcess.Environment, {
            T3CODE_RELEASE_BASE_URL: "https://releases.example/download",
          }),
          Effect.result,
        );
        expect(requests[0]).toBe("https://releases.example/download/v1.2.3/SHA256SUMS");
        if (checksum === digest) {
          expect(result._tag).toBe("Success");
          expect(phases).toEqual(["download", "verify"]);
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure.message).toMatch(/SHA-256|SHA256SUMS/);
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
