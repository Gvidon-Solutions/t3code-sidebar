// @effect-diagnostics nodeBuiltinImport:off -- The loopback echo fixture is the sshd byte-pipe boundary.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import { EnvironmentHttpApi, EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { Tool, Toolkit } from "effect/ai";
import {
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Auth from "../../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../../auth/http.ts";
import * as OAuth from "../../auth/McpOAuth.ts";
import * as OAuthHttp from "../../auth/mcpOAuthHttp.ts";
import * as Secrets from "../../auth/ServerSecretStore.ts";
import * as Config from "../../config.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as ServerHttp from "../../http.ts";
import * as Mcp from "../../mcp/McpHttpServer.ts";
import * as McpAccess from "../../mcp/McpToolAccess.ts";
import * as Registry from "../../mcp/McpSessionRegistry.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Settings from "../../serverSettings.ts";
import * as Links from "../PeerLinks.ts";
import * as Client from "../PeerMcpClient.ts";
import { descriptorOf } from "../PeerLinks.testkit.ts";
import * as Dispatcher from "./PeerCallDispatcherLive.ts";
import * as Credentials from "./PeerCredentials.ts";
import * as Facts from "./PeerFacts.ts";
import * as PeerHttp from "./PeerHttp.ts";
import * as PipeIpc from "./PeerPipeIpc.ts";
import * as Receipts from "./PeerReceipts.ts";
import * as Sessions from "./PeerSessions.ts";
import * as Relay from "../../mesh/MeshRelay.ts";
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import * as Transport from "./PeerTransport.ts";
import * as Wire from "./PeerWire.ts";

class Api extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}
const Answer = Schema.Struct({ count: Schema.Number });
const toolkit = Toolkit.make(
  Tool.make("t3_create_fixture", { description: "Creates one fixture.", success: Answer }),
  Tool.make("t3_wait_fixture", { description: "Waits until cancelled.", success: Answer }),
  Tool.make("schedule_task", {
    description: "Schedules an idempotent fixture action.",
    parameters: Schema.Struct({ clientRequestId: Schema.optional(Schema.String) }),
    success: Answer,
  }),
);

const serve = Effect.fn("test.servePeerNetwork")(function* (
  name: string,
  options: { readonly sshdPort?: number; readonly id?: string } = {},
) {
  let count = 0;
  let blocked = false;
  let externalMcp = 0;
  let scheduledCount = 0;
  const schedules = new Map<string, number>();
  const waitingStarted = yield* Deferred.make<void>();
  const waitingCancelled = yield* Deferred.make<void>();
  const descriptor = descriptorOf(options.id ?? name, name);
  const environment = Layer.succeed(Environment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(descriptor.environmentId),
    getDescriptor: Effect.succeed(descriptor),
  });
  const common = yield* Layer.build(
    Auth.layer.pipe(
      Layer.provideMerge(
        Settings.layerTest({ linkedEnvironmentsEnabled: true, meshEnabled: true }),
      ),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(Secrets.layer),
      Layer.provideMerge(Environment.layerIdentity),
      Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "n1-network-" })),
      Layer.provideMerge(NodeServices.layer),
      Layer.fresh,
    ),
  );
  const peerLinks = Links.layer.pipe(Layer.provide(Transport.layer));
  const dispatcher = Dispatcher.layer.pipe(Layer.provideMerge(Credentials.layer));
  const sessions = Sessions.layer.pipe(
    Layer.provide(Wire.dialerLayer),
    Layer.provide(
      Facts.layerOf({
        version: "test",
        platform: { os: "test", arch: "test", release: "test" },
        user: "tester",
        sshd: options.sshdPort === undefined ? null : { port: options.sshdPort, hostKeys: [] },
      }),
    ),
    Layer.provideMerge(dispatcher),
    Layer.provideMerge(peerLinks),
    Layer.provideMerge(Transport.layer),
  );
  const routes = Layer.mergeAll(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide(OAuthHttp.layer.pipe(Layer.provide(OAuth.layer))),
      Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
    Mcp.toolkitRegistration(
      toolkit,
      McpAccess.toLayer(toolkit, {
        t3_create_fixture: McpAccess.reads(() => Effect.sync(() => ({ count: ++count }))),
        t3_wait_fixture: McpAccess.reads(() =>
          Deferred.succeed(waitingStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(waitingCancelled, undefined)),
          ),
        ),
        schedule_task: McpAccess.reads((input) =>
          Effect.sync(() => {
            const previous =
              input.clientRequestId === undefined
                ? undefined
                : schedules.get(input.clientRequestId);
            if (previous !== undefined) return { count: previous };
            const value = ++scheduledCount;
            if (input.clientRequestId !== undefined) schedules.set(input.clientRequestId, value);
            return { count: value };
          }),
        ),
      }),
    ).pipe(
      Layer.provideMerge(Mcp.layerMcpTransport),
      Layer.provide(OAuth.layerMcpClientAuthenticator),
      Layer.provide(
        Layer.mock(Registry.McpSessionRegistry)({
          // @effect-diagnostics-next-line effectSucceedWithVoid:off -- The registry returns an optional invocation, not void.
          resolve: () => Effect.succeed(undefined),
        }),
      ),
    ),
    PeerHttp.layer,
    PipeIpc.layer,
  ).pipe(
    Layer.provide(
      HttpRouter.middleware(
        (next) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (
              request.method === "POST" &&
              request.url.startsWith("/mcp") &&
              !(request.source instanceof globalThis.Request)
            ) {
              externalMcp++;
              if (blocked) return HttpServerResponse.empty({ status: 503 });
            }
            return yield* next;
          }),
        { global: true },
      ),
    ),
    Layer.provideMerge(Relay.layer),
    Layer.provideMerge(sessions),
    Layer.provideMerge(Client.layer),
    Layer.provideMerge(Receipts.layer),
    Layer.provideMerge(peerLinks),
    Layer.provideMerge(Transport.layer),
    Layer.provide(environment),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeedContext(common)),
  );
  const context = yield* Layer.build(
    HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.fresh,
    ),
  );
  const server = Context.get(context, HttpServer.HttpServer);
  const address = server.address;
  if (address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP test server");
  return {
    name,
    id: descriptor.environmentId,
    baseDir: Context.get(common, Config.ServerConfig).baseDir,
    blockHttp: () => {
      blocked = true;
    },
    externalMcp: () => externalMcp,
    url: `http://127.0.0.1:${address.port}`,
    links: Context.get(context, Links.PeerLinks),
    sessions: Context.get(context, Sessions.PeerSessions),
    client: Context.get(context, Client.PeerMcpClient),
    http: Context.get(context, HttpClient.HttpClient),
    auth: Context.get(common, Auth.EnvironmentAuth),
    count: () => count,
    waitingStarted,
    waitingCancelled,
    loseReceiptResults: Context.get(
      common,
      SqlClient.SqlClient,
    )`UPDATE peer_call_receipts SET result=NULL`,
  };
});

it.live(
  "upgrades a legacy one-way link, reconnects, dedupes across transports and unlinks both sides",
  () =>
    Effect.gen(function* () {
      const studio = yield* serve("studio");
      const cloudbox = yield* serve("cloudbox");
      const legacy = yield* cloudbox.auth.issueMcpClientSession({
        label: "Legacy studio",
        access: "full-access",
        peerLink: true,
        client: { deviceType: "bot" },
      });
      yield* studio.links.acceptGrant({
        environmentId: cloudbox.id,
        label: cloudbox.name,
        urls: [cloudbox.url],
        access: "full-access",
        token: legacy.token,
        expiresAt: legacy.expiresAt.epochMilliseconds,
      });
      const request = {
        environmentId: EnvironmentId.make("cloudbox"),
        tool: "t3_create_fixture",
        arguments: {},
        limits: { runtimeMode: "full-access" as const, interactionMode: "default" as const },
        success: Answer,
        idempotencyKey: "create-once",
      };
      expect(yield* studio.client.call(request)).toEqual({ count: 1 });
      expect(cloudbox.externalMcp()).toBeGreaterThan(0);
      const previousPosts = cloudbox.externalMcp();
      cloudbox.blockHttp();
      studio.blockHttp();
      const linked = yield* cloudbox.sessions.events.pipe(
        Stream.filter((event) => event.name === "peer.linked" && event.environmentId === "studio"),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* studio.sessions.start;
      yield* Fiber.join(linked);
      expect((yield* cloudbox.links.ids).map(String)).toEqual(["studio"]);
      expect(yield* studio.client.call(request)).toEqual({ count: 1 });
      expect(yield* studio.client.call(request)).toEqual({ count: 1 });
      expect(cloudbox.count()).toBe(1);
      expect(cloudbox.externalMcp()).toBe(previousPosts);
      const ordinary = yield* cloudbox.auth.issueMcpClientSession({
        label: "ordinary client",
        access: "full-access",
        peerLink: false,
        client: { deviceType: "bot" },
      });
      expect(
        (yield* cloudbox.http.get("/peer", {
          headers: { authorization: `Bearer ${ordinary.token}` },
        })).status,
      ).toBe(403);
      expect((yield* cloudbox.http.get("/peer")).status).toBe(401);
      const rebound = yield* cloudbox.http.get("/peer", {
        headers: { authorization: `Bearer ${legacy.token}`, "t3-peer-environment-id": "laptop" },
      });
      expect(rebound.status).toBe(403);
      expect(yield* rebound.text).toContain("bound to another environment");
      expect(
        yield* cloudbox.client.call({
          ...request,
          environmentId: EnvironmentId.make("studio"),
          idempotencyKey: "reverse-once",
        }),
      ).toEqual({ count: 1 });
      const reconnected = yield* waitEvent(studio, "peer.connected", cloudbox.id);
      yield* studio.sessions.close(cloudbox.id, "test network cut");
      yield* Fiber.join(reconnected);
      expect(yield* studio.client.call(request)).toEqual({ count: 1 });
      expect(cloudbox.count()).toBe(1);
      yield* cloudbox.auth.revokeSession(legacy.sessionId);
      expect((yield* studio.client.call(request).pipe(Effect.result))._tag).toBe("Failure");
      const unlinked = yield* waitEvent(studio, "peer.unlinked", cloudbox.id);
      yield* cloudbox.links.unlink(studio.id);
      yield* Fiber.join(unlinked);
      expect(yield* studio.links.ids).toEqual([]);
      expect(yield* cloudbox.links.ids).toEqual([]);
      const credential = HttpServerRequest.fromWeb(
        new Request(cloudbox.url, { headers: { authorization: `Bearer ${legacy.token}` } }),
      );
      expect(
        (yield* cloudbox.auth.authenticateMcpClient(credential).pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* studio.sessions.stop;
      yield* cloudbox.sessions.stop;
    }).pipe(Effect.scoped),
);

const pairNetwork = Effect.fn("test.pairNetwork")(function* (
  from: Effect.Success<ReturnType<typeof serve>>,
  to: Effect.Success<ReturnType<typeof serve>>,
) {
  const pairing = yield* to.auth.issuePairingCredential();
  yield* from.links.link({ url: to.url, pairingCode: pairing.credential, access: "full-access" });
});
const waitEvent = Effect.fn("test.waitPeerEvent")(
  (network: Effect.Success<ReturnType<typeof serve>>, name: string, environmentId: string) =>
    network.sessions.events.pipe(
      Stream.filter((event) => event.name === name && event.environmentId === environmentId),
      Stream.runHead,
      Effect.forkScoped({ startImmediately: true }),
    ),
);

it.live(
  "resumes a committed creation after receipt loss and accepts a maximum-length client request ID",
  () =>
    Effect.gen(function* () {
      const studio = yield* serve("studio");
      const cloudbox = yield* serve("cloudbox");
      yield* pairNetwork(studio, cloudbox);
      const linked = yield* waitEvent(cloudbox, "peer.linked", studio.id);
      yield* studio.sessions.start;
      yield* Fiber.join(linked);
      const request = {
        environmentId: cloudbox.id,
        tool: "schedule_task",
        arguments: {},
        limits: { runtimeMode: "full-access" as const, interactionMode: "default" as const },
        success: Answer,
        idempotencyKey: "schedule-once",
      };
      expect(yield* studio.client.call(request)).toEqual({ count: 1 });
      yield* cloudbox.loseReceiptResults;
      expect(yield* studio.client.call(request)).toEqual({ count: 1 });
      const maximumKey = {
        environmentId: cloudbox.id,
        tool: request.tool,
        limits: request.limits,
        success: Answer,
        arguments: { clientRequestId: "r".repeat(256) },
      };
      expect(yield* studio.client.call(maximumKey)).toEqual({ count: 2 });
      expect(yield* studio.client.call(maximumKey)).toEqual({ count: 2 });
      yield* studio.sessions.stop;
      yield* cloudbox.sessions.stop;
    }).pipe(Effect.scoped),
);

it.live("converges simultaneous real WebSocket dials to the same authenticated connection", () =>
  Effect.gen(function* () {
    const studio = yield* serve("studio");
    const cloudbox = yield* serve("cloudbox");
    yield* pairNetwork(studio, cloudbox);
    yield* pairNetwork(cloudbox, studio);
    studio.blockHttp();
    cloudbox.blockHttp();
    const inbound = Schema.is(Schema.Struct({ direction: Schema.Literal("inbound") }));
    const outbound = Schema.is(Schema.Struct({ direction: Schema.Literal("outbound") }));
    const studioReady = yield* studio.sessions.events.pipe(
      Stream.filter((event) => event.name === "peer.connected" && inbound(event.body)),
      Stream.runHead,
      Effect.forkScoped({ startImmediately: true }),
    );
    const cloudboxReady = yield* cloudbox.sessions.events.pipe(
      Stream.filter((event) => event.name === "peer.connected" && outbound(event.body)),
      Stream.runHead,
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Effect.all([studio.sessions.start, cloudbox.sessions.start], {
      concurrency: "unbounded",
    });
    yield* Fiber.join(studioReady);
    yield* Fiber.join(cloudboxReady);
    expect(yield* studio.sessions.status).toMatchObject([
      { environmentId: cloudbox.id, state: "direct", direction: "inbound" },
    ]);
    expect(yield* cloudbox.sessions.status).toMatchObject([
      { environmentId: studio.id, state: "direct", direction: "outbound" },
    ]);
    for (const [from, to] of [
      [studio, cloudbox],
      [cloudbox, studio],
    ] as const)
      expect(
        yield* from.client.call({
          environmentId: to.id,
          tool: "t3_create_fixture",
          arguments: {},
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          success: Answer,
        }),
      ).toEqual({ count: 1 });
    expect(studio.externalMcp() + cloudbox.externalMcp()).toBe(0);
    const waiting = yield* studio.client
      .call({
        environmentId: cloudbox.id,
        tool: "t3_wait_fixture",
        arguments: {},
        limits: { runtimeMode: "full-access", interactionMode: "default" },
        success: Answer,
      })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(cloudbox.waitingStarted);
    yield* Fiber.interrupt(waiting);
    yield* Deferred.await(cloudbox.waitingCancelled);
    expect(
      yield* studio.client.call({
        environmentId: cloudbox.id,
        tool: "t3_create_fixture",
        arguments: {},
        limits: { runtimeMode: "full-access", interactionMode: "default" },
        success: Answer,
      }),
    ).toEqual({ count: 2 });
    yield* studio.sessions.stop;
    yield* cloudbox.sessions.stop;
  }).pipe(Effect.scoped),
);

it.live("reaches an incoming-only machine through one relay for calls and a local IPC pipe", () =>
  Effect.gen(function* () {
    const sockets = new Set<NodeNet.Socket>();
    const echo = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<NodeNet.Server>((resolve) => {
            const server = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
              sockets.add(socket);
              socket.on("error", () => socket.destroy());
              socket.on("close", () => sockets.delete(socket));
              socket.pipe(socket);
            });
            server.listen(0, "127.0.0.1", () => resolve(server));
          }),
      ),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const socket of sockets) socket.destroy();
              server.close(() => resolve());
            }),
        ),
    );
    const address = echo.address();
    if (!address || typeof address === "string") return yield* Effect.die("Expected loopback port");
    const studio = yield* serve("studio", { sshdPort: address.port, id: "studio:environment" });
    const cloudbox = yield* serve("cloudbox");
    const laptop = yield* serve("laptop");
    yield* pairNetwork(studio, cloudbox);
    yield* pairNetwork(laptop, cloudbox);
    const studioLinked = yield* waitEvent(cloudbox, "peer.linked", studio.id);
    yield* studio.sessions.start;
    yield* Fiber.join(studioLinked);
    const laptopLinked = yield* waitEvent(cloudbox, "peer.linked", laptop.id);
    const laptopRoute = yield* waitEvent(laptop, "peer.routes", cloudbox.id);
    yield* laptop.sessions.start;
    yield* Fiber.join(laptopLinked);
    yield* Fiber.join(laptopRoute);
    expect((yield* cloudbox.links.get(studio.id)).pipe(Option.getOrThrow).urls).toEqual([]);
    expect(
      (yield* cloudbox.links.list).find((link) => link.environmentId === studio.id)?.status,
    ).toBe("reachable");
    studio.blockHttp();
    cloudbox.blockHttp();
    laptop.blockHttp();
    const request = {
      environmentId: studio.id,
      tool: "t3_create_fixture",
      arguments: {},
      limits: { runtimeMode: "full-access" as const, interactionMode: "default" as const },
      success: Answer,
      idempotencyKey: "same-key-different-caller",
    };
    expect(yield* cloudbox.client.call(request)).toEqual({ count: 1 });
    expect(yield* laptop.client.call(request)).toEqual({ count: 2 });
    expect(yield* laptop.client.call(request)).toEqual({ count: 2 });
    expect(
      (yield* laptop.sessions.status).find((state) => state.environmentId === studio.id),
    ).toMatchObject({ state: "relayed", via: cloudbox.id });
    const stream = yield* PipeIpc.connectLocalPipe(laptop.baseDir, studio.id);
    const payload = Buffer.alloc(1024 * 1024, 71);
    const received = yield* Effect.promise(async () => {
      const hash = NodeCrypto.createHash("sha256");
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        hash.update(chunk);
      }
      return { size, digest: hash.digest("hex") };
    }).pipe(Effect.forkScoped({ startImmediately: true }));
    const expected = NodeCrypto.createHash("sha256");
    for (let index = 0; index < 200; index++) {
      expected.update(payload);
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) =>
            stream.write(payload, (error) => (error ? reject(error) : resolve())),
          ),
      );
    }
    stream.end();
    expect(yield* Fiber.join(received)).toEqual({
      size: 200 * 1024 * 1024,
      digest: expected.digest("hex"),
    });
    expect(studio.externalMcp() + cloudbox.externalMcp() + laptop.externalMcp()).toBe(0);
    yield* studio.sessions.stop;
    yield* cloudbox.sessions.stop;
    yield* laptop.sessions.stop;
  }).pipe(Effect.scoped),
);
