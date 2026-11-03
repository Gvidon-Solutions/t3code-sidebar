import { it, expect } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { MeshRelay, layer } from "./MeshRelay.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";

it.effect.each(["full-access", "read-only", "approval-required"] as const)(
  "routes reads through a %s target link, refuses a third hop and loops",
  (access) =>
    Effect.gen(function* () {
      const relay = yield* MeshRelay;
      expect(yield* relay.routes).toEqual(["C"]);
      const input = {
        environmentId: EnvironmentId.make("C"),
        tool: "t3_thread_read",
        arguments: {},
      };
      const limits = { runtimeMode: "full-access", interactionMode: "default" } as const;
      expect(yield* relay.relay(input, ["A"], limits)).toEqual({ hops: ["A", "B"] });
      expect(
        yield* relay
          .relay(input, ["A", "other"], limits)
          .pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error })),
      ).toMatchObject({ code: "capability_denied" });
      expect(
        yield* relay
          .relay(input, ["B"], limits)
          .pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error })),
      ).toMatchObject({ code: "capability_denied" });
      expect(
        yield* relay
          .relay(input, ["C"], limits)
          .pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error })),
      ).toMatchObject({ code: "capability_denied" });
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ServerEnvironment, {
                getEnvironmentId: Effect.succeed(EnvironmentId.make("B")),
                getDescriptor: Effect.succeed(descriptorOf("B", "B")),
              }),
              Layer.mock(PeerLinks)({
                list: Effect.succeed([
                  {
                    environmentId: EnvironmentId.make("C"),
                    access,
                    status: "reachable",
                    label: "C",
                    urls: [],
                    linkedAt: DateTime.makeUnsafe(0),
                    expiresAt: DateTime.makeUnsafe(9999999999999),
                    lastReachedAt: null,
                    lastError: null,
                  },
                ]),
                get: () =>
                  Effect.succeedSome({
                    environmentId: EnvironmentId.make("C"),
                    access,
                    label: "C",
                    urls: [],
                    linkedAt: DateTime.makeUnsafe(0),
                    expiresAt: DateTime.makeUnsafe(9999999999999),
                    lastReachedAt: null,
                    lastError: null,
                  }),
              }),
              Layer.succeed(PeerMcpClient, {
                call: (input) => Effect.succeed({ hops: input.hops } as typeof input.success.Type),
              }),
            ),
          ),
        ),
      ),
    ),
);
