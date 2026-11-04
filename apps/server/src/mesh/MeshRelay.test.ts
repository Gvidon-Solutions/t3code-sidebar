import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import { layerTest as layoutTest } from "../replicas/MeshLayoutTestLayer.ts";
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

it.effect(
  "checks the origin/destination policy on a relay and forwards a projects-only file ceiling",
  () =>
    Effect.gen(function* () {
      const mesh = yield* MeshLayoutService;
      const h = yield* mesh.nextHlc;
      yield* mesh.apply({
        "mesh.config": {
          h,
          v: {
            revision: h,
            author: "B",
            writtenAt: "",
            doc: {
              schema: 1,
              machines: { studio: {}, cloudbox: {}, laptop: {} },
              links: {
                default: { files: "all" },
                overrides: [
                  {
                    between: ["studio", "laptop"],
                    files: "projects",
                    threads: false,
                    replicas: false,
                  },
                ],
              },
            },
          },
        },
        "mesh.machineBinding/studio": { h, v: "A" },
        "mesh.machineBinding/cloudbox": { h, v: "B" },
        "mesh.machineBinding/laptop": { h, v: "C" },
      });
      const relay = yield* MeshRelay;
      const limits = { runtimeMode: "full-access", interactionMode: "default" } as const;
      for (const tool of ["t3_thread_read", "t3_project_place"])
        expect(
          (yield* relay
            .relay({ environmentId: EnvironmentId.make("C"), tool, arguments: {} }, ["A"], limits)
            .pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error })))?.code,
        ).toBe("capability_denied");
      const value = yield* relay.relay(
        {
          environmentId: EnvironmentId.make("C"),
          tool: "t3_files_read",
          arguments: { absolutePath: "/app/file" },
        },
        ["A"],
        limits,
      );
      expect(value).toEqual({ files: "projects", replicas: false });
      const allowedThreads = yield* mesh.nextHlc;
      yield* mesh.apply({
        "mesh.config": {
          h: allowedThreads,
          v: {
            revision: allowedThreads,
            author: "B",
            writtenAt: "",
            doc: {
              schema: 1,
              machines: { studio: {}, cloudbox: {}, laptop: {} },
              links: {
                overrides: [{ between: ["studio", "laptop"], threads: true, replicas: false }],
              },
            },
          },
        },
      });
      expect(
        yield* relay.relay(
          {
            environmentId: EnvironmentId.make("C"),
            tool: "t3_thread_receive_fork",
            arguments: { action: "prepare" },
          },
          ["A"],
          limits,
        ),
      ).toEqual({ replicas: false });
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              layoutTest("B", DEFAULT_SIDEBAR_WORKSPACES_CONFIG),
              Layer.succeed(McpInvocationContext, {
                environmentId: EnvironmentId.make("B"),
                issuedAt: 0,
                requestNamespace: "relay-test",
                thread: undefined,
                client: {
                  sessionId: "link",
                  label: "Studio",
                  peerEnvironmentId: EnvironmentId.make("A"),
                  linked: true,
                  access: "full-access",
                },
                capabilities: new Set<import("../mcp/McpInvocationContext.ts").McpCapability>(),
              }),
              Layer.succeed(ServerEnvironment, {
                getEnvironmentId: Effect.succeed(EnvironmentId.make("B")),
                getDescriptor: Effect.succeed(descriptorOf("B", "Cloudbox")),
              }),
              Layer.mock(PeerLinks)({
                get: () =>
                  Effect.succeedSome({
                    environmentId: EnvironmentId.make("C"),
                    label: "Laptop",
                    urls: [],
                    access: "full-access",
                    linkedAt: DateTime.makeUnsafe(0),
                    expiresAt: DateTime.makeUnsafe(9999999999999),
                    lastReachedAt: null,
                    lastError: null,
                  }),
              }),
              Layer.succeed(PeerMcpClient, {
                call: (input) =>
                  Effect.succeed({
                    ...(input.limits.files ? { files: input.limits.files } : {}),
                    ...(input.limits.replicas === false ? { replicas: false } : {}),
                  } as typeof input.success.Type),
              }),
            ),
          ),
        ),
      ),
    ),
);
