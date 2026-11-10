import * as MeshTestServices from "../../testFixtures/meshServices.ts";
import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import * as Mcp from "../mcp/McpHttpServer.ts";
import { McpSessionRegistry } from "../mcp/McpSessionRegistry.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Settings from "../serverSettings.ts";
import { forkMarker, ThreadForkService } from "./ThreadForkService.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import { layerLinkedTest } from "../../testFixtures/MeshLayoutTestLayer.ts";
import * as Receipts from "../peer/connection/PeerReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
it.effect(
  "accepts forks only for full-access link sessions and hides the receiver from agents",
  () =>
    Effect.gen(function* () {
      const mesh = yield* MeshLayoutService;
      let received = 0;
      const database = yield* Layer.build(Sqlite.layerMemory);
      const services = yield* Layer.build(
        Layer.mergeAll(
          Settings.layerTest({ linkedEnvironmentsEnabled: true }),
          Receipts.layer.pipe(Layer.provide(Layer.succeedContext(database))),
        ),
      );
      const settings = Context.get(services, Settings.ServerSettingsService);
      const transport = Mcp.layerMcpTransport(Layer.empty).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeedContext(services),
            Layer.succeed(MeshLayoutService, mesh),
            Layer.mock(McpSessionRegistry)({
              // @effect-diagnostics-next-line effectSucceedWithUndefined:off - Registry absence requires undefined.
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
                    peerEnvironmentId: EnvironmentId.make("laptop"),
                  },
                };
                return Effect.succeed(scope);
              },
            }),
            Layer.mock(ThreadForkService)({
              receive: (input) =>
                input.action === "rollback" && input.forkId === "storage-failure"
                  ? Effect.fail(
                      new OrchestratorMcpFailure({
                        code: "orchestration_error",
                        message: "Fork transaction storage failed.",
                      }),
                    )
                  : Effect.sync(() => {
                      received++;
                      return { ok: true };
                    }),
            }),
          ),
        ),
      );
      yield* HttpRouter.serve(transport, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const client = yield* HttpClient.HttpClient;
      const post = Effect.fn("test.meshPost")(
        (token: string, body: unknown, session?: string, key?: string) =>
          client.post("/mcp", {
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/json, text/event-stream",
              ...(session ? { "mcp-session-id": session } : {}),
              ...(key ? { "t3-idempotency-key": key } : {}),
            },
            body: HttpBody.text(encode(body), "application/json"),
          }),
      );
      const body = {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "t3_thread_receive_fork",
          arguments: { action: "rollback", forkId: "L-fork" },
        },
      };
      expect((yield* post("agent", body)).status).toBe(403);
      expect((yield* post("readonly", body)).status).toBe(403);
      const accepted = yield* post("link", body, undefined, "fork-once");
      expect(accepted.status).toBe(200);
      expect(yield* accepted.text).toContain('"ok":true');
      expect((yield* post("link", body, undefined, "fork-once")).status).toBe(200);
      expect(received).toBe(1);
      const sql = Context.get(database, SqlClient.SqlClient);
      expect(yield* sql`SELECT request_key FROM peer_call_receipts`).toEqual([
        { request_key: "fork-once" },
      ]);
      yield* sql`UPDATE peer_call_receipts SET result=NULL WHERE request_key='fork-once'`;
      expect(yield* sql`SELECT result FROM peer_call_receipts`).toEqual([{ result: null }]);
      expect((yield* post("link", body, undefined, "fork-once")).status).toBe(200);
      expect(received).toBe(2);
      yield* settings.updateSettings({ linkedEnvironmentsEnabled: false });
      expect((yield* post("link", body, undefined, "fork-once")).status).toBe(403);
      expect(received).toBe(2);
      yield* settings.updateSettings({ linkedEnvironmentsEnabled: true });
      const failed = yield* post("link", {
        ...body,
        params: { ...body.params, arguments: { action: "rollback", forkId: "storage-failure" } },
      });
      expect(yield* failed.text).toContain("orchestration_error");
      const h = yield* mesh.nextHlc;
      yield* mesh.apply({
        "mesh.config": {
          h,
          v: {
            revision: h,
            doc: { schema: 1, machines: {}, links: { default: { threads: false } } },
            author: "studio",
            writtenAt: "2026-01-01T00:00:00Z",
          },
        },
      });
      const denied = yield* post("link", body);
      expect(denied.status).toBe(403);
      expect(yield* denied.text).toContain("link_threads_denied");
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
      expect(yield* listed.text).not.toContain("t3_thread_receive_fork");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          Layer.merge(
            NodeHttpServer.layerTest,
            layerLinkedTest("B", { cloudbox: "B", laptop: "laptop" }),
          ),
          MeshTestServices.required,
        ),
      ),
    ),
);

it("escapes a peer-supplied title in the fork marker link", () => {
  expect(forkMarker("Fix ] link ) now", "t3-thread://v2/env/thread?x=(y)", "cloudbox")).toBe(
    "Forked from [Fix \\] link \\) now](t3-thread://v2/env/thread?x=%28y%29) · cloudbox",
  );
  expect(forkMarker("[a](http://evil)", "t3-thread://v2/env/thread", "studio")).toBe(
    "Forked from [\\[a\\]\\(http://evil\\)](t3-thread://v2/env/thread) · studio",
  );
});

it("neutralizes newlines, backticks and non-thread link schemes in the fork marker", () => {
  expect(forkMarker("Fix\nnow `x`", "t3-thread://v2/env/thread", "cloud\nbox")).toBe(
    "Forked from [Fix now \\`x\\`](t3-thread://v2/env/thread) · cloud box",
  );
  expect(forkMarker("Title", "javascript:alert(1)", "studio")).toBe("Forked from Title · studio");
  expect(forkMarker("Title", "not a url", "studio")).toBe("Forked from Title · studio");
  expect(forkMarker("Title", "http://host/t", "studio")).toBe("Forked from Title · studio");
  expect(forkMarker("Title", "https://host/a b[c]", "studio")).toBe("Forked from Title · studio");
});
