import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import * as Mcp from "../mcp/McpHttpServer.ts";
import { McpSessionRegistry } from "../mcp/McpSessionRegistry.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Settings from "../serverSettings.ts";
import { MeshReplicator } from "./MeshReplicator.ts";
import { MeshRelay } from "./MeshRelay.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
it.effect(
  "accepts mesh exchange only for full-access link sessions and hides it from tool lists",
  () =>
    Effect.gen(function* () {
      const transport = Mcp.layerMcpTransport(Layer.empty).pipe(
        Layer.provide(
          Layer.mergeAll(
            Settings.layerTest({ linkedEnvironmentsEnabled: true }),
            Layer.mock(McpSessionRegistry)({
              // @effect-diagnostics-next-line effectSucceedWithVoid:off - Registry absence requires undefined.
              resolve: () => Effect.succeed(undefined),
            }),
            Layer.succeed(Mcp.McpClientAuthenticator, {
              authenticate: (request) => {
                const token = request.headers.authorization?.slice(7);
                const scope: McpInvocationScope = {
                  environmentId: EnvironmentId.make("B"),
                  issuedAt: 0,
                  requestNamespace: token ?? "unknown",
                  capabilities: new Set(),
                  thread: undefined,
                  client: {
                    sessionId: "session",
                    label: "test",
                    access: token === "readonly" ? "read-only" : "full-access",
                    linked: token !== "agent",
                  },
                };
                return Effect.succeed(scope);
              },
            }),
            Layer.succeed(MeshReplicator, {
              exchange: (input) => Effect.succeed({ entries: input.entries, seq: input.seq }),
              sync: Effect.void,
              status: Effect.succeed({ peers: [] }),
            }),
            Layer.mock(MeshRelay)({
              routes: Effect.succeed(["studio"]),
              status: Effect.succeed([
                {
                  environmentId: "studio",
                  state: "direct",
                  via: null,
                  direction: "inbound",
                  connectedAt: "2026-11-04T00:00:00.000Z",
                  offlineSince: null,
                  lastError: null,
                },
              ]),
            }),
          ),
        ),
      );
      yield* HttpRouter.serve(transport, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const client = yield* HttpClient.HttpClient;
      const post = Effect.fn("test.meshPost")((token: string, body: unknown, session?: string) =>
        client.post("/mcp", {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json, text/event-stream",
            ...(session ? { "mcp-session-id": session } : {}),
          },
          body: HttpBody.text(encode(body), "application/json"),
        }),
      );
      const body = {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "t3_mesh_exchange",
          arguments: { fromEnvironmentId: "A", entries: {}, seq: 0, ackReceivedSeq: 0 },
        },
      };
      expect((yield* post("agent", body)).status).toBe(403);
      expect((yield* post("readonly", body)).status).toBe(403);
      const accepted = yield* post("link", body);
      expect(accepted.status).toBe(200);
      expect(yield* accepted.text).toContain('"seq\\":0');
      const legacyRoutes = yield* post("link", {
        ...body,
        params: { name: "t3_mesh_routes", arguments: {} },
      });
      expect(yield* legacyRoutes.text).toContain('[\\"studio\\"]');
      const routes = yield* post("link", {
        ...body,
        params: { name: "t3_mesh_routes", arguments: { details: true } },
      });
      const details = yield* routes.text;
      expect(details).toContain('\\"connections\\"');
      expect(details).toContain('\\"state\\":\\"direct\\"');
      const init = yield* post("agent", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      });
      const listed = yield* post(
        "agent",
        { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
        init.headers["mcp-session-id"]!,
      );
      expect(listed.status).toBe(200);
      expect(yield* listed.text).not.toContain("t3_mesh_exchange");
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
