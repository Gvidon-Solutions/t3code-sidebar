import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import * as Mcp from "../mcp/McpHttpServer.ts";
import { McpSessionRegistry } from "../mcp/McpSessionRegistry.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../serverSettings.ts";
import * as ConfigTest from "./MeshConfigTestLayer.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
it.effect(
  "registers mesh config tools over HTTP with object-root schemas and serves real config calls",
  () =>
    Effect.gen(function* () {
      const dependencies = Layer.mergeAll(
        ConfigTest.layerTest("studio"),
        Settings.layerTest(),
        Layer.mock(ThreadManagementService)({}),
        Layer.mock(McpSessionRegistry)({
          // @effect-diagnostics-next-line effectSucceedWithVoid:off -- Registry misses return undefined rather than void.
          resolve: () => Effect.succeed(undefined),
        }),
        Layer.succeed(Mcp.McpClientAuthenticator, {
          authenticate: () =>
            Effect.succeed({
              environmentId: EnvironmentId.make("studio"),
              issuedAt: 0,
              requestNamespace: "owner",
              capabilities: new Set(["orchestration" as const]),
              thread: undefined,
              client: { sessionId: "owner", label: "Owner", access: "full-access" },
            }),
        }),
      );
      const transport = Mcp.layerMcpTransport.pipe(
        Layer.provide(Mcp.layerMeshToolkit),
        Layer.provide(dependencies),
      );
      yield* HttpRouter.serve(transport, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const client = yield* HttpClient.HttpClient;
      const post = Effect.fn("test.meshConfigHttp")((body: unknown, session?: string) =>
        client.post("/mcp", {
          headers: {
            authorization: "Bearer test",
            accept: "application/json, text/event-stream",
            ...(session ? { "mcp-session-id": session } : {}),
          },
          body: HttpBody.text(encode(body), "application/json"),
        }),
      );
      const initialized = yield* post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "C1-test", version: "1" },
        },
      });
      const session = initialized.headers["mcp-session-id"];
      expect(initialized.status).toBe(200);
      const listed = yield* post(
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        session,
      );
      expect(yield* listed.text).toContain("t3_mesh_config_get");
      const current = yield* post(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "t3_mesh_config_get", arguments: {} },
        },
        session,
      );
      expect(yield* current.text).toContain("current");
      const apply = yield* post(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "t3_mesh_config_apply",
            arguments: { doc: "schema: 1\nmachines: {}", baseRevision: null },
          },
        },
        session,
      );
      const body = yield* apply.text;
      expect(body).toContain("revision");
      expect(body).not.toContain('"isError":true');
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
