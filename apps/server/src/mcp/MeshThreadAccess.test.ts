import { McpDomainAnnotation } from "./McpToolDomain.ts";
import { layerLinkedTest } from "../../testFixtures/MeshLayoutTestLayer.ts";
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Tool, Toolkit } from "effect/ai";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import * as Forwarding from "../peer/PeerForwarding.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import * as Access from "./McpToolAccess.ts";
import { UiToolkit } from "./toolkits/ui/tools.ts";
import * as UiHandlers from "./toolkits/ui/handlers.ts";
import { UiRequests } from "../uiRequests/UiRequests.ts";
import { VoiceSessionServiceV2 } from "../orchestration-v2/VoiceSessionService.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const declaration = {
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
  }),
  success: Schema.Unknown,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext, ThreadManagementService],
};
const toolkit = Toolkit.make(
  Tool.make("t3_thread_list", declaration).annotate(McpDomainAnnotation, "threads"),
  Tool.make("t3_thread_read", declaration).annotate(McpDomainAnnotation, "threads"),
  Tool.make("t3_thread_send", declaration).annotate(McpDomainAnnotation, "threads"),
  Tool.make("t3_thread_fork", declaration).annotate(McpDomainAnnotation, "threads"),
);
const handlers = Access.toLayer(toolkit, {
  t3_thread_list: Access.reads(() =>
    Effect.succeed({ threads: [{ threadId: "mcp:local" }], total: 2, nextCursor: 1 }),
  ),
  t3_thread_read: Access.reads((input) => Effect.succeed({ thread: { threadId: input.threadId } })),
  t3_thread_send: Access.writesThreads(
    (input) => [input.threadId],
    () => Effect.succeed({ sent: true }),
  ),
  t3_thread_fork: Access.writesThreads(
    (input) => [input.threadId],
    () => Effect.succeed({ forked: "local" }),
  ),
});

it.effect(
  "fans out with partial results, resolves bare ids through a relay, and preserves write refusal",
  () => {
    const caller = liveThreadShell(ThreadId.make("mcp:caller"));
    let route = "remote";
    let failNextRead = false;
    const calls: { tool: string; environmentId: string; arguments: Record<string, unknown> }[] = [];
    const peer = (id: string) => ({
      environmentId: EnvironmentId.make(id),
      label: id,
      urls: [],
      access: "full-access" as const,
      status: "reachable" as const,
      linkedAt: DateTime.makeUnsafe(0),
      expiresAt: DateTime.makeUnsafe(9999999999999),
      lastReachedAt: null,
      lastError: null,
    });
    const links = Layer.mock(PeerLinks)({
      enabled: Effect.succeed(true),
      list: Effect.succeed([peer("relay"), peer("offline")]),
      get: (id) =>
        Effect.succeed(id === "relay" || id === "offline" ? Option.some(peer(id)) : Option.none()),
    });
    const peers = Layer.succeed(PeerMcpClient, {
      call: (input) => {
        calls.push(input);
        if (input.environmentId === "offline")
          return Effect.fail(
            new OrchestratorMcpFailure({ code: "orchestration_error", message: "offline" }),
          );
        if (input.tool === "t3_mesh_routes")
          return Effect.succeed([route] as typeof input.success.Type);
        if (input.tool === "t3_thread_read")
          return Effect.fail(
            new OrchestratorMcpFailure({ code: "thread_not_found", message: "not here" }),
          );
        const tool = input.tool === "t3_mesh_relay" ? input.arguments.tool : input.tool;
        const args = (
          input.tool === "t3_mesh_relay" ? input.arguments.arguments : input.arguments
        ) as Record<string, unknown>;
        if (tool === "t3_thread_read" && failNextRead && args.limit === undefined) {
          failNextRead = false;
          return Effect.fail(
            new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "Thread was removed.",
            }),
          );
        }
        if (tool === "t3_thread_send")
          return Effect.fail(
            new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "This link has read-only access.",
            }),
          );
        if (tool === "t3_thread_fork")
          return Effect.succeed({ forked: "remote" } as typeof input.success.Type);
        return Effect.succeed(
          (tool === "t3_thread_read"
            ? { thread: { threadId: "mcp:remote-thread" } }
            : { threads: [{ threadId: "mcp:remote-thread" }] }) as typeof input.success.Type,
        );
      },
    });
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      links,
      peers,
      Layer.succeed(McpInvocationContext, {
        environmentId: EnvironmentId.make("local"),
        requestNamespace: "mesh-test",
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
        thread: {
          threadId: caller.id,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionId: "test",
        },
        client: undefined,
      }),
      Layer.mock(ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(id === caller.id ? caller : null),
      }),
    );
    return Effect.gen(function* () {
      const tools = yield* toolkit.pipe(Effect.provide(Access.HandlersLayer.layer(handlers)));
      const list = yield* tools
        .handle("t3_thread_list", { environmentId: EnvironmentId.make("all") })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(list.at(-1)?.result).toMatchObject({
        total: 4,
        nextCursor: 1,
        threads: expect.arrayContaining([
          expect.objectContaining({ environmentId: "local" }),
          expect.objectContaining({ environmentId: "remote" }),
        ]),
        unreachable: [{ environmentId: "offline", message: expect.stringContaining("offline") }],
      });
      const read = yield* tools
        .handle("t3_thread_read", { threadId: ThreadId.make("remote-thread") })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(read.at(-1)?.result).toEqual({ thread: { threadId: "mcp:remote-thread" } });
      expect(calls).toContainEqual(
        expect.objectContaining({
          tool: "t3_mesh_relay",
          arguments: expect.objectContaining({ tool: "t3_thread_read", environmentId: "remote" }),
        }),
      );
      const send = yield* tools
        .handle("t3_thread_send", { threadId: ThreadId.make("remote-thread") })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(send.at(-1)?.result).toMatchObject({
        code: "capability_denied",
        message: expect.stringContaining("read-only"),
      });
      const fork = yield* tools
        .handle("t3_thread_fork", { threadId: ThreadId.make("remote-thread") })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(fork.at(-1)?.result).toEqual({ forked: "remote" });
      const opened: unknown[] = [];
      const uiServices = Layer.mergeAll(
        Layer.mock(VoiceSessionServiceV2)({}),
        Layer.mock(UiRequests)({
          open: (input) =>
            Effect.sync(() => {
              opened.push(input);
              return 1;
            }),
        }),
      );
      const ui = yield* UiToolkit.pipe(
        Effect.provide(
          Access.HandlersLayer.layer(UiHandlers.layer).pipe(Layer.provide(uiServices)),
        ),
      );
      yield* ui
        .handle("ui_open", { target: { kind: "thread", threadId: ThreadId.make("remote-thread") } })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(uiServices));
      expect(opened).toEqual([
        {
          threadId: caller.id,
          target: { kind: "thread", threadId: "mcp:remote-thread", environmentId: "remote" },
        },
      ]);
      const beforeFence = calls.length;
      const fenced = {
        ...caller,
        runtimeMode: "approval-required" as const,
        linkOrigin: {
          sessionId: "fenced",
          label: "Fenced peer",
          access: "approval-required" as const,
        },
      };
      const fenceResult = yield* tools
        .handle("t3_thread_list", { environmentId: EnvironmentId.make("all") })
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provide(
            Layer.mock(ThreadManagementService)({
              getThreadShell: (id) => Effect.succeed(id === caller.id ? fenced : null),
            }),
          ),
        );
      expect(fenceResult.at(-1)?.result).toMatchObject({
        code: "capability_denied",
        message: expect.stringContaining("linked environment"),
      });
      expect(calls.length).toBe(beforeFence);
      const beforeRefusal = calls.length;
      const denied = yield* tools.handle("t3_thread_send", { threadId: caller.id }).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provideService(McpInvocationContext, {
          environmentId: EnvironmentId.make("local"),
          requestNamespace: "read-only-link",
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
          thread: undefined,
          client: {
            sessionId: "read-only-link",
            label: "Read-only peer",
            peerEnvironmentId: EnvironmentId.make("peer"),
            access: "read-only",
            linked: true,
          },
        }),
        Effect.provide(
          layerLinkedTest("local", { local: "local", peer: "peer", remote: "remote" }),
        ),
      );
      expect(denied.at(-1)?.result).toMatchObject({
        code: "capability_denied",
        message: expect.stringContaining("read-only"),
      });
      expect(calls.length).toBe(beforeRefusal);
      failNextRead = true;
      const missing = yield* tools
        .handle("t3_thread_read", { threadId: ThreadId.make("remote-thread") })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(missing.at(-1)?.result).toMatchObject({ code: "thread_not_found" });
      route = "moved";
      const afterMissing = calls.length;
      const moved = yield* tools
        .handle("t3_thread_read", { threadId: ThreadId.make("remote-thread") })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(moved.at(-1)?.result).toEqual({ thread: { threadId: "mcp:remote-thread" } });
      expect(calls.slice(afterMissing)).not.toContainEqual(
        expect.objectContaining({ environmentId: "remote", tool: "t3_thread_read" }),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(dependencies, Forwarding.layer.pipe(Layer.provide(dependencies))),
      ),
    );
  },
);
