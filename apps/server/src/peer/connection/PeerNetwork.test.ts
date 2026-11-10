import { PEER_HOPS_ERROR } from "./peerIdentity.ts";
import * as MeshTestServices from "../../../testFixtures/meshServices.ts";
import migratePeerIdentities from "../../persistence/Migrations/1002_PeerIdentityBindings.ts";
import { McpDomainAnnotation } from "../../mcp/McpToolDomain.ts";
import { linkedTestDocument } from "../../../testFixtures/MeshLayoutTestLayer.ts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as EffectNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
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
import * as LegacySessions from "../../auth/SessionStore.ts";
import { mcpClientScopes } from "@t3tools/contracts";
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
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
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
import * as MeshLive from "../../mesh/MeshLayoutServiceLive.ts";
import { MeshLayoutService } from "../../mesh/MeshLayoutService.ts";
import * as Replication from "../../mesh/MeshReplicator.ts";
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import * as Transport from "./PeerTransport.ts";
import * as Wire from "./PeerWire.ts";

class Api extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}
const Answer = Schema.Struct({ count: Schema.Number });
const LimitsAnswer = Schema.Struct({
  files: Schema.optionalKey(Schema.Literals(["all", "projects", "none"])),
  replicas: Schema.optionalKey(Schema.Boolean),
});
const isExchange = Schema.is(Replication.ExchangeInput);
const isRoutes = Schema.is(Schema.Struct({ routes: Schema.Array(Schema.String) }));
const toolkit = Toolkit.make(
  Tool.make("t3_refuse_fixture", {
    description: "Refuses a fixture call.",
    success: Answer,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
  }).annotate(McpDomainAnnotation, "mesh"),
  Tool.make("t3_limits_fixture", {
    description: "Reports receiving call limits.",
    success: LimitsAnswer,
  }).annotate(McpDomainAnnotation, "mesh"),
  Tool.make("t3_thread_fixture", {
    description: "Reads one thread fixture.",
    success: Answer,
  }).annotate(McpDomainAnnotation, "threads"),
  Tool.make("t3_create_fixture", { description: "Creates one fixture.", success: Answer }).annotate(
    McpDomainAnnotation,
    "mesh",
  ),
  Tool.make("t3_wait_fixture", { description: "Waits until cancelled.", success: Answer }).annotate(
    McpDomainAnnotation,
    "mesh",
  ),
  Tool.make("schedule_task", {
    description: "Schedules an idempotent fixture action.",
    parameters: Schema.Struct({ clientRequestId: Schema.optional(Schema.String) }),
    success: Answer,
  }).annotate(McpDomainAnnotation, "threads"),
);

const serve = Effect.fn("test.servePeerNetwork")(function* (
  name: string,
  options: { readonly sshdPort?: number; readonly id?: string; readonly layout?: boolean } = {},
) {
  let count = 0;
  let blocked = false;
  let externalMcp = 0;
  let blockLayoutCalls = false;
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
      Layer.provideMerge(
        Layer.mergeAll(
          environment,
          Layer.succeed(Environment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(descriptor.environmentId),
          }),
        ),
      ),
      Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "mesh-network-" })),
      Layer.provideMerge(
        Layer.mergeAll(NodeServices.layer, EffectNodeCrypto.layer, ManagedPolicy.layerTest()),
      ),
      Layer.fresh,
    ),
  );
  const transportContext = yield* Layer.build(Layer.fresh(Transport.layer));
  const transport = Layer.succeed(
    Transport.PeerTransport,
    Context.get(transportContext, Transport.PeerTransport),
  );
  const peerLinks = Links.layer.pipe(Layer.provide(transport));
  const dispatcher = Layer.effect(
    Sessions.PeerCallDispatcher,
    Effect.map(Sessions.PeerCallDispatcher, (raw) =>
      Sessions.PeerCallDispatcher.of({
        make: Effect.fn("test.PeerCallDispatcher.make")((input) =>
          raw.make(input).pipe(
            Effect.map((made) => ({
              ...made,
              call: (body, signal) =>
                blockLayoutCalls && body.tool === "t3_mesh_exchange"
                  ? Promise.reject(
                      new Sessions.PeerConnectionError({
                        reason: "protocol",
                        message: "Fixture rejects layout MCP calls",
                      }),
                    )
                  : made.call(body, signal),
            })),
          ),
        ),
      }),
    ),
  ).pipe(Layer.provide(Dispatcher.layer), Layer.provideMerge(Credentials.layer));
  const mesh = MeshLive.layer;
  const replication = options.layout ? Replication.layer : Layer.empty;
  const sessions = Sessions.layer.pipe(
    Layer.provideMerge(mesh),
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
    Layer.provideMerge(transport),
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
        t3_limits_fixture: McpAccess.reads(() =>
          Effect.map(Effect.serviceOption(McpInvocationContext), (invocation) => {
            const scope = Option.getOrThrow(invocation);
            return {
              ...(scope.client?.filesLimit ? { files: scope.client.filesLimit } : {}),
              ...(scope.client?.replicasLimit === undefined
                ? {}
                : { replicas: scope.client.replicasLimit }),
            };
          }),
        ),
        t3_refuse_fixture: McpAccess.reads(() =>
          Effect.fail(
            new OrchestratorMcpFailure({ code: "invalid_request", message: "Fixture refusal" }),
          ),
        ),
        t3_thread_fixture: McpAccess.reads(() => Effect.succeed({ count: 99 })),
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
      Layer.provideMerge(Mcp.layerMcpTransport(Layer.empty)),
      Layer.provide(OAuth.layerMcpClientAuthenticator),
      Layer.provide(
        Layer.mock(Registry.McpSessionRegistry)({
          // @effect-diagnostics-next-line effectSucceedWithUndefined:off -- The registry returns an optional invocation, not void.
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
    Layer.provideMerge(replication),
    Layer.provideMerge(sessions),
    Layer.provideMerge(Client.layer),
    Layer.provideMerge(Receipts.layer),
    Layer.provideMerge(peerLinks),
    Layer.provideMerge(transport),
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
  const configuredMesh = Context.get(context, MeshLayoutService);
  const configuredClock = yield* configuredMesh.nextHlc;
  yield* configuredMesh.apply(
    linkedTestDocument(
      { studio: "studio", cloudbox: "cloudbox", laptop: "laptop" },
      configuredClock,
    ),
  );
  const server = Context.get(context, HttpServer.HttpServer);
  const address = server.address;
  if (address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP test server");
  return {
    name,
    sql: Context.get(common, SqlClient.SqlClient),
    issueLegacyPeer: (environmentId: string) =>
      Context.get(common, LegacySessions.SessionStore).issue({
        subject: "mcp-client",
        method: "bearer-access-token",
        scopes: mcpClientScopes("full-access"),
        runtimeModeCeiling: "full-access",
        peerLink: true,
        peerEnvironmentId: environmentId,
        client: { label: `Legacy ${environmentId}`, deviceType: "bot" },
      }),
    upgradeLegacyDatabase: Effect.gen(function* () {
      const sql = Context.get(common, SqlClient.SqlClient);
      yield* sql`DROP TABLE peer_session_identities`;
      yield* sql`DROP TABLE peer_client_identities`;
      yield* sql`DROP TABLE peer_legacy_identity_candidates`;
      yield* migratePeerIdentities.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    }),
    replication: Context.getOption(context, Replication.MeshReplicator),
    id: descriptor.environmentId,
    baseDir: Context.get(common, Config.ServerConfig).baseDir,
    blockHttp: () => {
      blocked = true;
    },
    blockLayoutCalls: () => {
      blockLayoutCalls = true;
    },
    externalMcp: () => externalMcp,
    url: `http://127.0.0.1:${address.port}`,
    links: Context.get(context, Links.PeerLinks),
    sessions: Context.get(context, Sessions.PeerSessions),
    client: Context.get(context, Client.PeerMcpClient),
    http: Context.get(context, HttpClient.HttpClient),
    transport: Context.get(context, Transport.PeerTransport),
    mesh: Context.get(context, MeshLayoutService),
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
      const legacy = yield* cloudbox.issueLegacyPeer(studio.id);
      yield* cloudbox.upgradeLegacyDatabase;
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
      const limitedRequest = {
        ...request,
        tool: "t3_limits_fixture",
        idempotencyKey: "limited-fixture",
        limits: { ...request.limits, files: "none" as const, replicas: false },
        success: LimitsAnswer,
      };
      expect(yield* studio.client.call(limitedRequest)).toEqual({ files: "none", replicas: false });
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
      expect(
        yield* studio.sql<{
          environment_id: string;
          source: string;
        }>`SELECT environment_id, source FROM peer_session_identities`,
      ).toEqual([{ environment_id: "cloudbox", source: "mutual-grant" }]);
      expect(
        yield* cloudbox.sql<{
          environment_id: string;
          source: string;
        }>`SELECT environment_id, source FROM peer_session_identities WHERE source = 'legacy-local-link'`,
      ).toEqual([{ environment_id: "studio", source: "legacy-local-link" }]);
      expect(studio.transport.get()).toBe(studio.sessions);
      expect(yield* studio.client.call(request)).toEqual({ count: 1 });
      expect(yield* studio.client.call(request)).toEqual({ count: 1 });
      expect(cloudbox.count()).toBe(1);
      yield* studio.links.recordOutcome(cloudbox.id, { error: "Earlier outage" });
      const refusal = yield* studio.client
        .call({ ...request, tool: "t3_refuse_fixture", idempotencyKey: "refuse-once" })
        .pipe(Effect.flip);
      expect(refusal).toMatchObject({ code: "invalid_request", message: "Fixture refusal" });
      const healthy = yield* studio.links.get(cloudbox.id);
      expect(Option.getOrThrow(healthy).lastError).toBeNull();
      expect(cloudbox.externalMcp()).toBe(previousPosts);
      expect(
        yield* studio.client.call({ ...limitedRequest, idempotencyKey: "limited-socket" }),
      ).toEqual({ files: "none", replicas: false });
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
      expect(yield* rebound.text).toContain(PEER_HOPS_ERROR);
      expect(
        yield* cloudbox.client.call({
          ...request,
          environmentId: EnvironmentId.make("studio"),
          idempotencyKey: "reverse-once",
        }),
      ).toEqual({ count: 1 });
      expect((yield* studio.auth.listSessions()).map((session) => session.client.label)).toContain(
        "Linked machine · cloudbox",
      );
      const reconnected = yield* waitEvent(studio, "peer.connected", cloudbox.id);
      yield* studio.sessions.close(cloudbox.id, "test network cut");
      yield* Fiber.join(reconnected);
      expect(yield* studio.client.call(request)).toEqual({ count: 1 });
      expect(cloudbox.count()).toBe(1);
      const threadRequest = {
        ...request,
        tool: "t3_thread_fixture",
        idempotencyKey: "thread-before-policy-change",
      };
      expect(yield* studio.client.call(threadRequest)).toEqual({ count: 99 });
      const h = yield* cloudbox.mesh.nextHlc;
      yield* cloudbox.mesh.apply({
        "mesh.config": {
          h,
          v: {
            revision: h,
            author: "cloudbox",
            writtenAt: "",
            doc: { schema: 1, machines: {}, links: { default: { threads: false } } },
          },
        },
      });
      expect((yield* studio.client.call(threadRequest).pipe(Effect.flip)).code).toBe(
        "capability_denied",
      );
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
    }).pipe(Effect.scoped, Effect.provide(MeshTestServices.required)),
);

const pairNetwork = Effect.fn("test.pairNetwork")(function* (
  from: Effect.Success<ReturnType<typeof serve>>,
  to: Effect.Success<ReturnType<typeof serve>>,
) {
  const pairing = yield* to.auth.issuePairingCredential();
  yield* from.links.link({ url: to.url, pairingCode: pairing.credential, access: "full-access" });
});
const waitEvent = Effect.fn("test.waitPeerEvent")(
  (
    network: Effect.Success<ReturnType<typeof serve>>,
    name: string,
    environmentId: string,
    accepts: (body: unknown) => boolean = () => true,
  ) =>
    network.sessions.events.pipe(
      Stream.filter(
        (event) =>
          event.name === name && event.environmentId === environmentId && accepts(event.body),
      ),
      Stream.runHead,
      Effect.forkScoped({ startImmediately: true }),
    ),
);

it.live("pushes layout as authenticated events when layout MCP calls are disabled", () =>
  Effect.gen(function* () {
    const studio = yield* serve("studio", { layout: true });
    const cloudbox = yield* serve("cloudbox", { layout: true });
    studio.blockHttp();
    cloudbox.blockHttp();
    studio.blockLayoutCalls();
    cloudbox.blockLayoutCalls();
    yield* pairNetwork(studio, cloudbox);
    const linked = yield* waitEvent(cloudbox, "peer.linked", studio.id);
    yield* studio.sessions.start;
    yield* Fiber.join(linked);
    const source = studio.mesh!;
    const destination = cloudbox.mesh!;
    const key = "custom/mesh-event";
    const forgedKey = "custom/mesh-forged";
    const forgedPublished = yield* cloudbox.transport.activity.pipe(
      Stream.filter(
        (activity) =>
          activity.kind === "event" &&
          activity.name === "mesh.layout.push" &&
          isExchange(activity.body) &&
          forgedKey in activity.body.entries,
      ),
      Stream.runHead,
      Effect.forkScoped({ startImmediately: true }),
    );
    expect(
      yield* studio.sessions.event(cloudbox.id, "mesh.layout.push", {
        fromEnvironmentId: "laptop",
        entries: { [forgedKey]: { h: yield* source.nextHlc, v: true } },
        seq: 1,
        ackReceivedSeq: 0,
      }),
    ).toBe(true);
    yield* Fiber.join(forgedPublished);
    const applied = yield* destination.changes.pipe(
      Stream.filter((snapshot) => snapshot.document[key] !== undefined),
      Stream.runHead,
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* source.apply({ [key]: { h: yield* source.nextHlc, v: { proof: 42 } } });
    yield* Fiber.join(applied);
    expect((yield* destination.read).document[key]?.v).toEqual({ proof: 42 });
    expect((yield* destination.read).document[forgedKey]).toBeUndefined();
    yield* studio.sessions.stop;
    yield* cloudbox.sessions.stop;
  }).pipe(Effect.scoped, Effect.provide(MeshTestServices.required)),
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
    }).pipe(Effect.scoped, Effect.provide(MeshTestServices.required)),
);

it.live("converges simultaneous real WebSocket dials to the same authenticated connection", () =>
  Effect.gen(function* () {
    const studio = yield* serve("studio");
    const cloudbox = yield* serve("cloudbox");
    yield* pairNetwork(studio, cloudbox);
    yield* pairNetwork(cloudbox, studio);
    studio.blockHttp();
    cloudbox.blockHttp();
    const connectionChange = yield* cloudbox.links.changes!.pipe(
      Stream.runHead,
      Effect.forkScoped({ startImmediately: true }),
    );
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
    expect(studio.transport.get()).toBe(studio.sessions);
    expect(cloudbox.transport.get()).toBe(cloudbox.sessions);
    expect(studio.transport).not.toBe(cloudbox.transport);

    yield* Fiber.join(studioReady);

    yield* Fiber.join(cloudboxReady);

    yield* Fiber.join(connectionChange);

    expect(yield* studio.client.connectionAvailable!(cloudbox.id)).toBe(true);
    expect(yield* cloudbox.client.connectionAvailable!(studio.id)).toBe(true);

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
  }).pipe(Effect.scoped, Effect.provide(MeshTestServices.required)),
);

it.live("reaches an incoming-only machine through one relay for calls and a local IPC pipe", () =>
  Effect.gen(function* () {
    const sockets = new Set<NodeNet.Socket>();
    let receivedFirstHalf: (() => void) | undefined;
    let recordMode = true;
    const echo = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<NodeNet.Server>((resolve) => {
            const server = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
              sockets.add(socket);
              socket.on("error", () => socket.destroy());
              socket.on("close", () => sockets.delete(socket));
              socket.setNoDelay(true);
              let pending = Buffer.alloc(0);
              socket.on("data", (chunk: Buffer) => {
                if (!recordMode) {
                  socket.write(chunk);
                  return;
                }
                pending = Buffer.concat([pending, chunk]);
                if (pending.length === 1024) receivedFirstHalf?.();
                if (pending.length === 2048) {
                  socket.write(pending);
                  pending = Buffer.alloc(0);
                }
              });
              socket.on("end", () => socket.end());
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
    const advertised = yield* waitEvent(
      laptop,
      "peer.routes",
      cloudbox.id,
      (body) => isRoutes(body) && body.routes.includes("transient-one"),
    );
    yield* cloudbox.sessions.event(laptop.id, "peer.routes", {
      routes: [studio.id, "transient-one", "transient-two"],
    });
    yield* Fiber.join(advertised);
    expect(
      (yield* laptop.sessions.status).some((peer) => peer.environmentId === "transient-one"),
    ).toBe(true);
    const withdrawnTransient = yield* waitEvent(
      laptop,
      "peer.routes",
      cloudbox.id,
      (body) => isRoutes(body) && !body.routes.includes("transient-one"),
    );
    yield* cloudbox.sessions.event(laptop.id, "peer.routes", { routes: [studio.id] });
    yield* Fiber.join(withdrawnTransient);
    expect(
      (yield* laptop.sessions.status).some((peer) => peer.environmentId.startsWith("transient-")),
    ).toBe(false);

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
    const policyClock = yield* cloudbox.mesh.nextHlc;
    yield* cloudbox.mesh.apply({
      "mesh.config": {
        h: policyClock,
        v: {
          revision: policyClock,
          author: "cloudbox",
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
                  replicas: false,
                  threads: false,
                },
              ],
            },
          },
        },
      },
      "mesh.machineBinding/studio": { h: policyClock, v: studio.id },
      "mesh.machineBinding/cloudbox": { h: policyClock, v: cloudbox.id },
      "mesh.machineBinding/laptop": { h: policyClock, v: laptop.id },
    });
    expect(
      yield* laptop.client.call({
        ...request,
        tool: "t3_limits_fixture",
        idempotencyKey: "limited-fixture",
        success: LimitsAnswer,
      }),
    ).toEqual({ files: "projects", replicas: false });
    expect(
      (yield* laptop.client
        .call({ ...request, tool: "t3_thread_fixture", idempotencyKey: "limited-fixture" })
        .pipe(Effect.flip)).message,
    ).toContain("does not allow");
    expect(
      (yield* laptop.client
        .call({ ...request, tool: "t3_project_place", idempotencyKey: "limited-fixture" })
        .pipe(Effect.flip)).message,
    ).toContain("does not allow");
    expect(
      (yield* laptop.sessions.status).find((state) => state.environmentId === studio.id),
    ).toMatchObject({ state: "relayed", via: cloudbox.id });
    yield* laptop.mesh.edit((config) => ({
      ...config,
      machines: {
        ...config.machines,
        [studio.id]: { ...config.machines[studio.id], title: "Studio build" },
      },
    }));
    const records = yield* PipeIpc.connectLocalPipe(laptop.baseDir, "Studio build");
    yield* Effect.addFinalizer(() => Effect.sync(() => records.destroy()));
    const recordReader = records[Symbol.asyncIterator]();
    const half = Buffer.alloc(1024, 37);
    const writeHalf = () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) =>
            records.write(half, (error) => (error ? reject(error) : resolve())),
          ),
      );
    // SSH records may arrive in separate writes while the previous TCP segment is unacknowledged.
    for (let index = 0; index < 4096; index++) {
      const firstHalf = new Promise<void>((resolve) => {
        receivedFirstHalf = resolve;
      });
      yield* writeHalf();
      yield* Effect.promise(() => firstHalf);
      yield* writeHalf();
      const record = yield* Effect.promise(async () => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        while (bytes < 2048) {
          const chunk = await recordReader.next();
          if (chunk.done) throw new Error("SSH record stream ended early");
          const data = Buffer.from(chunk.value);
          bytes += data.length;
          chunks.push(data);
        }
        return Buffer.concat(chunks);
      });
      expect(record).toEqual(Buffer.concat([half, half]));
    }
    records.destroy();
    recordMode = false;
    const stream = yield* PipeIpc.connectLocalPipe(laptop.baseDir, "Studio build");
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
    const withdrawn = yield* laptop.sessions.events.pipe(
      Stream.filter(
        (event) =>
          event.environmentId === cloudbox.id &&
          event.name === "peer.routes" &&
          isRoutes(event.body) &&
          !event.body.routes.includes(studio.id),
      ),
      Stream.runHead,
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* studio.sessions.stop;
    yield* Fiber.join(withdrawn);
    const offline = yield* PipeIpc.connectLocalPipe(laptop.baseDir, studio.id).pipe(Effect.flip);
    expect(offline.message).toContain("No live peer connection reaches");
    yield* cloudbox.sessions.stop;
    yield* laptop.sessions.stop;
  }).pipe(Effect.scoped, Effect.provide(MeshTestServices.required)),
);

it.live.each(["none", "outgoing", "machine-binding"] as const)(
  "binds only legacy credentials with existing local %s trust",
  (trust) =>
    Effect.gen(function* () {
      const receiver = yield* serve("cloudbox", { layout: true });
      const legacy = yield* receiver.issueLegacyPeer("laptop");
      yield* receiver.upgradeLegacyDatabase;
      yield* receiver.sql`DELETE FROM mesh_layout_entries WHERE key LIKE 'mesh.machineBinding/%'`;
      if (trust === "outgoing")
        yield* receiver.sql`INSERT INTO peer_environment_links(environment_id, secret_name, label, urls_json, access, linked_at, expires_at) VALUES ('laptop', 'legacy-outgoing-token', 'Laptop', '["https://laptop.example.test"]', 'full-access', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z')`;
      if (trust === "machine-binding")
        yield* receiver.sql`INSERT INTO mesh_layout_entries(key, value, hlc, seq) VALUES ('mesh.machineBinding/laptop', '"laptop"', '1:0:cloudbox', 1)`;
      const fresh = yield* receiver.auth.issueMcpClientSession({
        label: "Unbound new token",
        access: "full-access",
        peerLink: true,
        client: { deviceType: "bot" },
      });
      for (const claimed of ["laptop", undefined]) {
        const refused = yield* receiver.http.get("/peer", {
          headers: {
            authorization: `Bearer ${fresh.token}`,
            ...(claimed ? { "t3-peer-environment-id": claimed } : {}),
          },
        });
        expect(refused.status).toBe(401);
        expect(yield* refused.text).toContain("Pair the machines again");
      }
      expect(
        yield* receiver.sql`SELECT * FROM peer_session_identities WHERE session_id = ${fresh.sessionId}`,
      ).toEqual([]);
      const first = yield* receiver.http.get("/peer", {
        headers: {
          authorization: `Bearer ${legacy.token}`,
          "t3-peer-environment-id": "unknown-peer",
        },
      });
      expect(first.status).toBe(401);
      const matching = yield* receiver.http.get("/peer", {
        headers: { authorization: `Bearer ${legacy.token}`, "t3-peer-environment-id": "laptop" },
      });
      expect(matching.status).toBe(trust === "none" ? 401 : 400);
      const bindings = yield* receiver.sql<{
        environment_id: string;
      }>`SELECT environment_id FROM peer_session_identities WHERE session_id = ${legacy.sessionId}`;
      expect(bindings).toEqual(trust === "none" ? [] : [{ environment_id: "laptop" }]);
      if (trust !== "none") {
        const status = yield* Option.getOrThrow(receiver.replication).status;
        expect(status.legacyIdentityUpgrades).toEqual([
          expect.objectContaining({ sessionId: legacy.sessionId, environmentId: "laptop" }),
        ]);
        for (const headers of [
          { "t3-peer-environment-id": "studio" },
          { "t3-mesh-hops": "studio,unknown-peer" },
          { "t3-mesh-hops": "studio" },
          { "t3-mesh-hops": "laptop,laptop" },
        ]) {
          const spoofed = yield* receiver.http.post("/mcp", {
            headers: { authorization: `Bearer ${legacy.token}`, ...headers },
          });
          expect(spoofed.status).toBe(403);
        }
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(NodeServices.layer, MeshTestServices.required)),
    ),
);

it.live("upgrades mutual legacy link records without pairing again", () =>
  Effect.gen(function* () {
    const studio = yield* serve("studio", { layout: true });
    const cloudbox = yield* serve("cloudbox", { layout: true });
    const studioToken = yield* studio.issueLegacyPeer(cloudbox.id);
    const cloudboxToken = yield* cloudbox.issueLegacyPeer(studio.id);
    yield* studio.links.acceptGrant({
      environmentId: cloudbox.id,
      label: "Cloudbox",
      urls: [cloudbox.url],
      token: cloudboxToken.token,
      access: "full-access",
      expiresAt: cloudboxToken.expiresAt.epochMilliseconds,
    });
    yield* cloudbox.links.acceptGrant({
      environmentId: studio.id,
      label: "Studio",
      urls: [studio.url],
      token: studioToken.token,
      access: "full-access",
      expiresAt: studioToken.expiresAt.epochMilliseconds,
    });
    for (const receiver of [studio, cloudbox]) {
      yield* receiver.upgradeLegacyDatabase;
      yield* receiver.sql`DELETE FROM mesh_layout_entries WHERE key LIKE 'mesh.machineBinding/%'`;
    }
    for (const [sender, receiver] of [
      [studio, cloudbox],
      [cloudbox, studio],
    ] as const) {
      expect(
        yield* sender.client.call({
          environmentId: receiver.id,
          tool: "t3_create_fixture",
          arguments: {},
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          success: Answer,
        }),
      ).toEqual({ count: 1 });
      expect(
        yield* receiver.sql<{
          environment_id: string;
          source: string;
        }>`SELECT environment_id, source FROM peer_session_identities`,
      ).toEqual([{ environment_id: sender.id, source: "legacy-local-link" }]);
      expect(yield* receiver.sql`SELECT * FROM peer_legacy_identity_candidates`).toEqual([]);
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(NodeServices.layer, MeshTestServices.required)),
  ),
);
