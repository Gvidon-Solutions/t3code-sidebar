// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off effectFnOpportunity:off runEffectInsideEffect:off -- The peer manager owns Node Duplex pipes, synchronous wire callbacks and its own retry clock; transport failures are intentionally plain Errors.
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";

import {
  EnvironmentId,
  AuthMcpClientAccess,
  ProviderInteractionMode,
  RuntimeMode,
  type SidebarMachineReported,
  type PeerConnectionStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as PeerCredentials from "./PeerCredentials.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as MeshLayoutService from "../../mesh/MeshLayoutService.ts";
import * as PeerLinks from "../PeerLinks.ts";
import { isLocalLoopbackHost, isTailnetHost } from "@t3tools/shared/hostClassification";
import * as PeerFacts from "./PeerFacts.ts";
import * as PeerTransport from "./PeerTransport.ts";
import { PeerChannel, preferConnection, reconnectDelay } from "./PeerChannel.ts";
import { PeerConnectionError } from "./PeerConnectionError.ts";
import { forwardedCallLimits } from "../../mesh/MeshLinkPermissions.ts";
import { McpInvocationContext, type McpCapability } from "../../mcp/McpInvocationContext.ts";
export { PeerConnectionError };

/** The JSON body a peer call carries over the connection. */
export const PeerCallBody = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tool"),
    tool: Schema.String,
    arguments: Schema.Record(Schema.String, Schema.Unknown),
    limits: Schema.Struct({
      files: Schema.optionalKey(Schema.Literals(["all", "projects", "none"])),
      replicas: Schema.optionalKey(Schema.Boolean),
      runtimeMode: RuntimeMode,
      interactionMode: ProviderInteractionMode,
    }),
    hops: Schema.optionalKey(Schema.Array(Schema.String)),
    key: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("relay"),
    environmentId: Schema.String,
    tool: Schema.String,
    arguments: Schema.Record(Schema.String, Schema.Unknown),
    limits: Schema.Struct({
      files: Schema.optionalKey(Schema.Literals(["all", "projects", "none"])),
      replicas: Schema.optionalKey(Schema.Boolean),
      runtimeMode: RuntimeMode,
      interactionMode: ProviderInteractionMode,
    }),
    hops: Schema.Array(Schema.String),
    key: Schema.optionalKey(Schema.String),
  }),
]);
export type PeerCallBody = typeof PeerCallBody.Type;

/** A tool result as the MCP endpoint produced it; the caller decodes the text. */
export const PeerCallResult = Schema.Struct({
  text: Schema.String,
  isError: Schema.Boolean,
});
export type PeerCallResult = typeof PeerCallResult.Type;

/** One wire socket. The transport decides whether it is a dial or an accepted upgrade. */
export interface PeerWire {
  readonly send: (frame: string) => void;
  readonly close: (reason?: Error) => void;
  readonly frames: AsyncIterable<string>;
  /** Resolves once the transport has closed, so an HTTP upgrade handler can stay alive. */
  readonly done: Promise<void>;
}

export class PeerWireDialer extends Context.Service<
  PeerWireDialer,
  {
    readonly dial: (input: {
      readonly environmentId: EnvironmentId;
      readonly url: string;
      readonly token: string;
      readonly callerEnvironmentId?: string;
    }) => Effect.Effect<PeerWire, Error, Scope.Scope>;
  }
>()("t3/peer/connection/PeerSessions/PeerWireDialer") {}

/** Opens the peer's real target for a pipe (its loopback sshd). Injectable for tests. */
export class PeerPipeConnector extends Context.Service<
  PeerPipeConnector,
  {
    readonly connect: (input: {
      readonly host: string;
      readonly port: number;
    }) => Effect.Effect<NodeStream.Duplex, Error>;
  }
>()("t3/peer/connection/PeerSessions/PeerPipeConnector") {}

/**
 * Mints a local MCP credential for one peer and dispatches calls received over
 * its connection through the same HTTP MCP endpoint. The server adapter owns it.
 */
export class PeerCallDispatcher extends Context.Service<
  PeerCallDispatcher,
  {
    readonly make: (input: {
      readonly environmentId: string;
      readonly access: AuthMcpClientAccess;
      readonly token?: string;
    }) => Effect.Effect<
      {
        readonly token: string;
        readonly expiresAt?: number;
        readonly call: (body: PeerCallBody, signal: AbortSignal) => Promise<unknown>;
      },
      PeerConnectionError
    >;
  }
>()("t3/peer/connection/PeerSessions/PeerCallDispatcher") {}

/** What a peer reports about itself over the connection. */
export const PeerHello = Schema.Struct({
  facts: PeerFacts.PeerFacts,
  /** The sender's linked environment ids, so the receiver knows mutual trust is missing. */
  links: Schema.Array(Schema.String),
});
export type PeerHello = typeof PeerHello.Type;

const PeerGrant = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  urls: Schema.Array(Schema.String),
  access: AuthMcpClientAccess,
  expiresAt: Schema.optionalKey(Schema.Number),
  token: Schema.String,
});

const PeerRoutes = Schema.Struct({ routes: Schema.Array(Schema.String) });
const RelayedPipe = Schema.fromJsonString(
  Schema.Struct({ environmentId: Schema.String, target: Schema.Literal("sshd") }),
);
const encodeRelayedPipe = Schema.encodeSync(RelayedPipe);
const decodeRelayedPipe = Schema.decodeUnknownOption(RelayedPipe);
const encodeWireJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCallBody = Schema.decodeUnknownSync(PeerCallBody);
const decodeCallResult = Schema.decodeUnknownEffect(PeerCallResult);
const isConnectionError = Schema.is(PeerConnectionError);
const decodeHello = Schema.decodeUnknownOption(PeerHello);
const decodeGrant = Schema.decodeUnknownOption(PeerGrant);
const decodeRoutes = Schema.decodeUnknownOption(PeerRoutes);

export interface PeerEvent {
  readonly environmentId: string;
  readonly name: string;
  readonly body: unknown;
}

interface Live {
  readonly environmentId: string;
  readonly direction: "inbound" | "outbound";
  channel: PeerChannel;
  readonly wire: PeerWire;
  readonly connectedAt: number;
  readonly access: AuthMcpClientAccess;
  facts: PeerFacts.PeerFacts | undefined;
  routes: Set<string>;
  linkObserved: boolean;
  readonly call: (body: PeerCallBody, signal: AbortSignal) => Promise<unknown>;
}

export class PeerSessions extends Context.Service<
  PeerSessions,
  {
    /** Whether a direct authenticated connection to `environmentId` is live. */
    readonly connected: (environmentId: string) => Effect.Effect<boolean>;
    /** Direct or one-hop relayed state for every linked environment. */
    readonly status: Effect.Effect<ReadonlyArray<PeerConnectionStatus>>;
    /** Fire-and-forget notification; false when no direct connection exists. */
    readonly event: (environmentId: string, name: string, body: unknown) => Effect.Effect<boolean>;
    readonly events: Stream.Stream<PeerEvent>;
    readonly facts: (environmentId: string) => Effect.Effect<PeerFacts.PeerFacts | undefined>;
    readonly call: (input: {
      readonly environmentId: string;
      readonly body: PeerCallBody;
      readonly key?: string;
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    }) => Effect.Effect<PeerCallResult, PeerConnectionError>;
    readonly openPipe: (input: {
      readonly environmentId: string;
      readonly target: string;
      readonly signal?: AbortSignal;
    }) => Effect.Effect<NodeStream.Duplex, PeerConnectionError>;
    /** Adds an authenticated live channel. The loser of a tie-break is closed here. */
    readonly accept: (input: {
      readonly environmentId: EnvironmentId;
      readonly direction: "inbound" | "outbound";
      readonly access?: AuthMcpClientAccess;
      readonly wire: PeerWire;
      /** Dispatches a tool call received on this connection (authenticated as its link). */
      readonly call: (body: PeerCallBody, signal: AbortSignal) => Promise<unknown>;
    }) => Effect.Effect<void, PeerConnectionError>;
    /** Closes the connection to one peer, if any. */
    readonly close: (environmentId: string, reason?: string) => Effect.Effect<void>;
    /** Tells the peer to forget us, then closes the connection. */
    readonly revoke: (
      environmentId: string,
      notifyPeer?: boolean,
    ) => Effect.Effect<void, PeerConnectionError>;
    /** Reconcile every link forever: dial missing direct connections with backoff. */
    readonly start: Effect.Effect<void>;
    readonly stop: Effect.Effect<void>;
  }
>()("t3/peer/connection/PeerSessions") {}

const wsOrigin = (url: string) => {
  const parsed = URL.parse(url);
  if (parsed === null || !["https:", "http:"].includes(parsed.protocol))
    throw new Error("Peer origin must use HTTPS");
  if (
    parsed.protocol === "http:" &&
    !isLocalLoopbackHost(parsed.hostname) &&
    !isTailnetHost(parsed.hostname)
  )
    throw new Error("Plain WS is allowed only on loopback or an encrypted tailnet");
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/peer";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};

const toReported = (facts: PeerFacts.PeerFacts): SidebarMachineReported => ({
  version: facts.version,
  platform: { ...facts.platform },
  user: facts.user,
  ...(facts.meshPublicKey ? { meshPublicKey: facts.meshPublicKey } : {}),
  sshd: facts.sshd === null ? null : { port: facts.sshd.port, hostKeys: [...facts.sshd.hostKeys] },
  reportedAt: DateTime.formatIso(DateTime.nowUnsafe()),
  ...(facts.connections === undefined ? {} : { connections: [...facts.connections] }),
});

const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "peer connection failed";

/** Wires a one-frame-at-a-time wire into a PeerChannel. Exported for the HTTP adapter and tests. */
export const makeChannel = (
  wire: PeerWire,
  now: () => number,
  handlers: {
    readonly call: (body: unknown, signal: AbortSignal) => Promise<unknown>;
    readonly event: (name: string, body: unknown) => void;
    readonly pipe: (target: string, stream: NodeStream.Duplex) => void;
    readonly onClose: (reason: Error) => void;
  },
) => {
  let channel: PeerChannel | undefined;
  channel = new PeerChannel({
    send: (frame) => wire.send(frame),
    close: (reason) => {
      wire.close(reason);
      handlers.onClose(reason);
    },
    call: handlers.call,
    event: handlers.event,
    pipe: handlers.pipe,
    now,
  });
  void (async () => {
    try {
      for await (const frame of wire.frames) channel?.receive(frame);
    } catch (error) {
      channel?.close(error instanceof Error ? error : new Error(messageOf(error)));
    }
    channel?.close(new Error("Peer socket closed"));
  })();
  return channel;
};

const defaultPipeConnector = Layer.succeed(
  PeerPipeConnector,
  PeerPipeConnector.of({
    connect: ({ host, port }) =>
      Effect.tryPromise({
        try: (signal) =>
          new Promise<NodeStream.Duplex>((resolve, reject) => {
            const socket = NodeNet.createConnection(
              { host, port, allowHalfOpen: true, signal },
              () => resolve(socket),
            );
            socket.once("error", reject);
          }),
        catch: (error) => new Error(messageOf(error)),
      }),
  }),
);

const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const self = yield* environment.getEnvironmentId;
  const descriptor = yield* environment.getDescriptor;
  const clock = yield* Clock.Clock;
  const nowMs = () => Number(clock.currentTimeNanosUnsafe() / 1_000_000n);
  const callbackContext = yield* Effect.context<Scope.Scope>();
  const run = Effect.runPromiseWith(callbackContext);
  const links = yield* PeerLinks.PeerLinks;
  const dialer = yield* PeerWireDialer;
  const connector = yield* PeerPipeConnector;
  const factsReporter = yield* PeerFacts.PeerFactsReporter;
  const dispatcher = yield* PeerCallDispatcher;
  const mesh = yield* Effect.serviceOption(MeshLayoutService.MeshLayoutService);
  const events = yield* PubSub.unbounded<PeerEvent>();
  const slot = yield* Effect.serviceOption(PeerTransport.PeerTransport);

  const live = new Map<string, Live>();
  let stopped = false;
  const attempt = new Map<string, { attempt: number; nextAt: number; lastError: string | null }>();
  const offlineSince = new Map<string, string>();
  const knownRelays = new Set<string>();
  const reachableRelays = new Set<string>();
  const relayErrors = new Map<string, string>();
  const credentials = yield* Effect.serviceOption(PeerCredentials.PeerCredentials);

  const selfFacts = yield* factsReporter.collect;
  const selfId = String(self);
  const updateRelayState = (reason = "No connected relay advertises this machine") => {
    for (const target of knownRelays) {
      if (live.has(target) || [...live.values()].some((entry) => entry.routes.has(target))) {
        reachableRelays.add(target);
        offlineSince.delete(target);
        relayErrors.delete(target);
      } else if (reachableRelays.delete(target)) {
        offlineSince.set(target, DateTime.formatIso(DateTime.nowUnsafe()));
        relayErrors.set(target, reason);
      }
    }
  };
  if (Option.isSome(mesh)) {
    const previous = (yield* mesh.value.read).config;
    const states = previous.machines[selfId]?.reported?.connections ?? [];
    for (const environmentId of Object.keys(previous.machines)) {
      if (environmentId === selfId) continue;
      knownRelays.add(environmentId);
      const state = states.find((item) => item.environmentId === environmentId);
      offlineSince.set(
        environmentId,
        state?.offlineSince ?? DateTime.formatIso(DateTime.nowUnsafe()),
      );
      relayErrors.set(
        environmentId,
        state?.lastError ?? "Waiting for an authenticated peer connection",
      );
    }
  }

  /** Facts are reported, never edited: only `reported` changes in the machine entry. */
  const rememberFacts = (environmentId: string, facts: PeerFacts.PeerFacts) =>
    Option.isNone(mesh)
      ? Effect.void
      : mesh.value
          .edit((config) => {
            const previous = config.machines?.[environmentId] ?? {};
            return {
              ...config,
              machines: {
                ...config.machines,
                [environmentId]: { ...previous, reported: toReported(facts) },
              },
            };
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Peer facts could not be written to the layout", {
                environmentId,
                error,
              }),
            ),
            Effect.asVoid,
          );

  const notify = (entry: Live, name: string, body: unknown) =>
    Effect.try(() => {
      entry.channel.event(name, body);
      return true;
    }).pipe(
      Effect.catch((error) =>
        Effect.logDebug("Peer notification could not be sent", {
          environmentId: entry.environmentId,
          name,
          error,
        }).pipe(Effect.as(false)),
      ),
    );

  const grants = new Map<
    string,
    { token: string; access: AuthMcpClientAccess; expiresAt?: number }
  >();

  const routesOf = () => [...live.keys()];
  const reportOwnState = Effect.fn("PeerSessions.reportOwnState")(function* () {
    yield* rememberFacts(selfId, { ...selfFacts, connections: yield* status });
  });

  const announce = Effect.fn("PeerSessions.announce")(function* (entry: Live) {
    const known = yield* links.ids.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Peer link IDs could not be read", { error }).pipe(
          Effect.as([] as ReadonlyArray<EnvironmentId>),
        ),
      ),
    );
    const connections = yield* status;
    const facts = { ...selfFacts, connections };
    yield* rememberFacts(selfId, facts);
    yield* notify(entry, "peer.hello", { facts, links: known.map(String) });
    yield* notify(entry, "peer.routes", { routes: routesOf() });
  });

  const handleGrant = Effect.fn("PeerSessions.handleGrant")(function* (
    from: string,
    body: unknown,
  ) {
    const decoded = decodeGrant(body);
    if (Option.isNone(decoded) || decoded.value.environmentId !== from) return;
    const grant = decoded.value;
    yield* links
      .acceptGrant({
        environmentId: EnvironmentId.make(grant.environmentId),
        label: grant.label,
        urls: grant.urls,
        access: grant.access,
        ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
        token: grant.token,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Peer grant could not be stored", { from, error }),
        ),
      );
  });

  const closeLive = (environmentId: string, reason: Error) => {
    const entry = live.get(environmentId);
    if (entry === undefined) return;
    entry.channel.close(reason);
  };

  const bridge = (left: NodeStream.Duplex, right: NodeStream.Duplex) => {
    const destroy = (error: Error) => {
      if (!left.destroyed) left.destroy(error);
      if (!right.destroyed) right.destroy(error);
    };
    left.once("error", destroy);
    right.once("error", destroy);
    left.pipe(right);
    right.pipe(left);
  };

  const handlePipe = Effect.fn("PeerSessions.handlePipe")(function* (
    from: string,
    target: string,
    stream: NodeStream.Duplex,
  ) {
    if (live.get(from)?.access !== "full-access")
      return yield* new PeerConnectionError({
        reason: "pipe",
        message: "A byte pipe requires a full-access peer link",
      });
    if (target.startsWith("relay:")) {
      const decoded = decodeRelayedPipe(target.slice("relay:".length));
      if (Option.isNone(decoded))
        return yield* new PeerConnectionError({
          reason: "relay",
          message: "Invalid relayed pipe target",
        });
      const { environmentId, target: inner } = decoded.value;
      const destination = live.get(environmentId);
      if (!destination || environmentId === from || environmentId === selfId || inner !== "sshd")
        return yield* new PeerConnectionError({
          reason: "relay",
          message: "A pipe relay needs a direct destination and at most one hop",
        });
      const remote = destination.channel.openPipe(inner);
      bridge(stream, remote);
      return;
    }
    if (target !== "sshd") {
      stream.destroy(new Error(`Unknown peer pipe target ${target}`));
      return;
    }
    const socket = yield* connector.connect({
      host: "127.0.0.1",
      port: selfFacts.sshd?.port ?? 22,
    });
    bridge(stream, socket);
  });

  const dispatchCall = Effect.fn("PeerSessions.dispatchCall")(function* (
    body: PeerCallBody,
    environmentId: string,
    signal: AbortSignal,
  ) {
    if (body.kind === "relay") {
      if (
        live.get(environmentId)?.access !== "full-access" ||
        body.hops.length >= 1 ||
        body.environmentId === selfId ||
        body.environmentId === environmentId ||
        !live.has(body.environmentId)
      ) {
        return yield* new PeerConnectionError({
          reason: "relay",
          message: "Mesh relay allows one hop and no loops",
        });
      }
      const limits = yield* forwardedCallLimits(body.tool, body.limits, body.environmentId).pipe(
        Effect.provideService(McpInvocationContext, {
          environmentId: EnvironmentId.make(selfId),
          requestNamespace: `peer:${environmentId}`,
          issuedAt: 0,
          capabilities: new Set<McpCapability>(),
          thread: undefined,
          client: {
            sessionId: `peer:${environmentId}`,
            label: environmentId,
            access: live.get(environmentId)!.access,
            linked: true,
            peerEnvironmentId: environmentId,
          },
        }),
        Effect.mapError(
          (error) => new PeerConnectionError({ reason: "relay", message: error.message }),
        ),
      );
      return yield* call({
        environmentId: body.environmentId,
        body: {
          kind: "tool",
          tool: body.tool,
          arguments: body.arguments,
          limits,
          hops: [environmentId, selfId],
          ...(body.key === undefined ? {} : { key: body.key }),
        },
        signal,
      });
    }
    const entry = live.get(environmentId);
    if (entry === undefined) {
      return yield* new PeerConnectionError({
        reason: "offline",
        message: "The peer connection closed before the call was dispatched",
      });
    }
    const result = yield* Effect.tryPromise({
      try: () => entry.call(body, signal),
      catch: (error) => new PeerConnectionError({ reason: "protocol", message: messageOf(error) }),
    });
    return yield* decodeCallResult(result).pipe(
      Effect.mapError(
        (error) =>
          new PeerConnectionError({
            reason: "protocol",
            message: "The local MCP endpoint answered in an unexpected shape",
            cause: error,
          }),
      ),
    );
  });

  const handleEvent = Effect.fn("PeerSessions.handleEvent")(function* (
    from: string,
    name: string,
    body: unknown,
  ) {
    if (name === "peer.hello") {
      const decoded = decodeHello(body);
      if (Option.isNone(decoded)) return;
      const entry = live.get(from);
      if (entry !== undefined) entry.facts = decoded.value.facts;
      yield* rememberFacts(from, decoded.value.facts);
      if (!decoded.value.links.includes(selfId) && entry !== undefined) {
        const pending = grants.get(from);
        if (pending !== undefined)
          yield* notify(entry, "peer.grant", {
            environmentId: selfId,
            label: descriptor.label,
            urls: [],
            access: pending.access,
            token: pending.token,
            ...(pending.expiresAt === undefined ? {} : { expiresAt: pending.expiresAt }),
          });
      }
      return;
    }
    if (name === "peer.routes") {
      const decoded = decodeRoutes(body);
      const entry = live.get(from);
      if (Option.isNone(decoded) || entry === undefined) return;
      entry.routes = new Set(decoded.value.routes.filter((id) => id !== selfId && id !== from));
      for (const target of entry.routes) knownRelays.add(target);
      updateRelayState();
      yield* reportOwnState();
      yield* PubSub.publish(events, { environmentId: from, name, body });
      return;
    }
    if (name === "peer.grant") {
      yield* handleGrant(from, body);
      yield* PubSub.publish(events, { environmentId: from, name: "peer.linked", body: {} });
      return;
    }
    if (name === "peer.unlink") {
      yield* links
        .unlink(EnvironmentId.make(from), { notifyPeer: false })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Remote unlink could not be stored", { from, error }).pipe(
              Effect.as(false),
            ),
          ),
        );
      yield* Effect.sync(() => closeLive(from, new Error("The peer unlinked this machine")));
      yield* PubSub.publish(events, { environmentId: from, name: "peer.unlinked", body: {} });
      return;
    }
    yield* PubSub.publish(events, { environmentId: from, name, body });
    if (Option.isSome(slot))
      yield* slot.value.publish({ kind: "event", environmentId: from, name, body });
  });

  const attach = Effect.fn("PeerSessions.attach")(function* (
    environmentId: EnvironmentId,
    direction: "inbound" | "outbound",
    wire: PeerWire,
    callHandler: (body: PeerCallBody, signal: AbortSignal) => Promise<unknown>,
    access: AuthMcpClientAccess = "full-access",
  ) {
    const env = String(environmentId);
    if (stopped) {
      wire.close(new Error("Peer network stopped"));
      return;
    }
    const existing = live.get(env);
    if (existing !== undefined) {
      const incomingPreferred = preferConnection(selfId, env, direction === "outbound");
      const existingPreferred = preferConnection(selfId, env, existing.direction === "outbound");
      if (!incomingPreferred && existingPreferred) {
        wire.close(new Error("A preferred peer connection already exists"));
        return;
      }
      live.delete(env);
      existing.channel.close(new Error("Replaced by a newer peer connection"));
    }
    const entry: Live = {
      environmentId: env,
      direction,
      access,
      connectedAt: DateTime.nowUnsafe().epochMilliseconds,
      facts: undefined,
      routes: new Set(),
      linkObserved: direction === "outbound",
      channel: undefined as unknown as PeerChannel,
      wire,
      call: callHandler,
    };
    const channel = makeChannel(wire, nowMs, {
      call: async (body, signal) => {
        const decoded = decodeCallBody(body);
        return run(dispatchCall(decoded, env, signal), { signal });
      },
      event: (name, body) => {
        void run(
          handleEvent(env, name, body).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Peer event failed", { env, name, cause }),
            ),
          ),
        );
      },
      pipe: (target, stream) => {
        const controller = new AbortController();
        stream.once("close", () => controller.abort());
        stream.on("error", (error) => {
          void run(Effect.logDebug("Peer pipe closed", { env, error }));
        });
        void run(
          handlePipe(env, target, stream).pipe(
            Effect.catch((error) =>
              Effect.sync(() => stream.destroy(new Error(messageOf(error), { cause: error }))),
            ),
            Effect.catchCause((cause) =>
              Effect.sync(() => stream.destroy(new Error("Peer pipe target failed", { cause }))),
            ),
          ),
          { signal: controller.signal },
        );
      },
      onClose: (reason) => {
        if (live.get(env)?.channel === channel) {
          live.delete(env);
          updateRelayState(reason.message);
          for (const other of live.values()) {
            void run(notify(other, "peer.routes", { routes: routesOf() }));
          }
          offlineSince.set(env, DateTime.formatIso(DateTime.nowUnsafe()));
          attempt.set(env, {
            attempt: attempt.get(env)?.attempt ?? 0,
            nextAt: nowMs(),
            lastError: reason.message,
          });
          void run(reportOwnState());
        }
      },
    });
    entry.channel = channel;
    live.set(env, entry);
    updateRelayState();
    attempt.delete(env);
    offlineSince.delete(env);
    yield* Effect.whileLoop({
      while: () => live.get(env)?.channel === channel,
      body: () => Effect.sleep("1 second").pipe(Effect.andThen(Effect.sync(() => channel.tick()))),
      step: () => undefined,
    }).pipe(Effect.forkScoped);
    yield* announce(entry);
    yield* PubSub.publish(events, {
      environmentId: env,
      name: "peer.connected",
      body: { direction },
    });
    if (Option.isSome(slot)) yield* slot.value.publish({ kind: "connected", environmentId: env });
    for (const other of live.values())
      if (other !== entry) yield* notify(other, "peer.routes", { routes: routesOf() });
  });

  const status: PeerSessions["Service"]["status"] = Effect.gen(function* () {
    const ids = yield* links.ids.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Peer status links could not be read", { error }).pipe(
          Effect.as([] as ReadonlyArray<EnvironmentId>),
        ),
      ),
    );
    const relayed = new Map<string, string>();
    for (const [via, entry] of [...live].sort(([left], [right]) => left.localeCompare(right))) {
      for (const target of entry.routes) {
        if (target !== selfId && !live.has(target) && !relayed.has(target))
          relayed.set(target, via);
      }
    }
    return [...new Set([...ids.map(String), ...live.keys(), ...knownRelays])]
      .sort()
      .map((environmentId): PeerConnectionStatus => {
        const entry = live.get(environmentId);
        const via = relayed.get(environmentId);
        const failed = attempt.get(environmentId);
        return {
          environmentId,
          sourceEnvironmentId: selfId,
          observedAt: DateTime.formatIso(DateTime.nowUnsafe()),
          state: entry !== undefined ? "direct" : via !== undefined ? "relayed" : "offline",
          via: entry === undefined ? (via ?? null) : null,
          direction: entry?.direction ?? null,
          connectedAt:
            entry === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(entry.connectedAt)),
          offlineSince:
            entry === undefined && via === undefined
              ? (offlineSince.get(environmentId) ?? null)
              : null,
          lastError:
            entry !== undefined || via !== undefined
              ? null
              : (failed?.lastError ?? relayErrors.get(environmentId) ?? null),
        };
      });
  });

  const call: PeerSessions["Service"]["call"] = Effect.fn("PeerSessions.call")(function* (input) {
    const direct = live.get(input.environmentId);
    const target =
      direct ??
      [...live.values()]
        .sort((a, b) => a.environmentId.localeCompare(b.environmentId))
        .find((entry) => entry.routes.has(input.environmentId));
    if (target === undefined) {
      return yield* new PeerConnectionError({
        reason: "offline",
        message: `No live peer connection reaches ${input.environmentId}`,
      });
    }
    if (input.body.kind === "relay" || (!direct && (input.body.hops?.length ?? 0) > 0)) {
      return yield* new PeerConnectionError({
        reason: "relay",
        message: "A relayed call cannot be relayed again",
      });
    }
    const body: PeerCallBody =
      direct !== undefined
        ? { ...input.body, ...(input.key === undefined ? {} : { key: input.key }) }
        : {
            kind: "relay",
            environmentId: input.environmentId,
            tool: input.body.tool,
            arguments: input.body.arguments,
            limits: input.body.limits,
            hops: [],
            ...(input.key === undefined ? {} : { key: input.key }),
          };
    return yield* Effect.tryPromise({
      try: (signal) =>
        target.channel.call(body, {
          ...(input.key === undefined ? {} : { key: input.key }),
          signal: input.signal ?? signal,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        }) as Promise<PeerCallResult>,
      catch: (error) => new PeerConnectionError({ reason: "protocol", message: messageOf(error) }),
    }).pipe(
      Effect.flatMap((result) => decodeCallResult(result)),
      Effect.mapError((error) =>
        isConnectionError(error)
          ? error
          : new PeerConnectionError({
              reason: "protocol",
              message: "A peer call answered in an unexpected shape",
              cause: error,
            }),
      ),
    );
  });

  const openPipe: PeerSessions["Service"]["openPipe"] = Effect.fn("PeerSessions.openPipe")(
    function* (input) {
      if (input.target !== "sshd")
        return yield* new PeerConnectionError({
          reason: "pipe",
          message: `Unknown peer pipe target ${input.target}`,
        });
      const direct = live.get(input.environmentId);
      const relay =
        direct ??
        [...live.values()]
          .sort((left, right) => left.environmentId.localeCompare(right.environmentId))
          .find((entry) => entry.routes.has(input.environmentId));
      if (relay === undefined) {
        return yield* new PeerConnectionError({
          reason: "offline",
          message: `No live peer connection reaches ${input.environmentId}`,
        });
      }
      const target =
        direct !== undefined
          ? input.target
          : `relay:${encodeRelayedPipe({ environmentId: input.environmentId, target: "sshd" })}`;
      return yield* Effect.try({
        try: () => {
          const stream = relay.channel.openPipe(target);
          const abort = () => stream.destroy(new Error("Peer pipe cancelled"));
          input.signal?.addEventListener("abort", abort, { once: true });
          stream.once("close", () => input.signal?.removeEventListener("abort", abort));
          if (input.signal?.aborted) abort();
          return stream;
        },
        catch: (error) => new PeerConnectionError({ reason: "pipe", message: messageOf(error) }),
      });
    },
  );

  const close: PeerSessions["Service"]["close"] = (environmentId, reason) =>
    Effect.sync(() => closeLive(environmentId, new Error(reason ?? "Peer connection closed")));

  const revoke = Effect.fn("PeerSessions.revoke")(function* (
    environmentId: string,
    notifyPeer = true,
  ) {
    const entry = live.get(environmentId);
    if (entry !== undefined) {
      if (notifyPeer) yield* notify(entry, "peer.unlink", {});
      yield* Effect.sync(() => closeLive(environmentId, new Error("Unlinked")));
    }
    if (!entry && notifyPeer) {
      const delivery = yield* Effect.gen(function* () {
        const resolved = yield* links.resolve(EnvironmentId.make(environmentId));
        const wire = yield* dialer.dial({
          environmentId: EnvironmentId.make(environmentId),
          url: wsOrigin(resolved.url),
          token: resolved.token,
          callerEnvironmentId: selfId,
        });
        wire.send(encodeWireJson({ type: "event", name: "peer.unlink", body: {} }));
        wire.close();
        yield* Effect.promise(() => wire.done);
      }).pipe(Effect.result);
      if (delivery._tag === "Failure")
        yield* links.recordOutcome(EnvironmentId.make(environmentId), {
          error: "The peer was offline while unlinking",
        });
      closeLive(environmentId, new Error("Unlinked"));
    }
    if (Option.isSome(credentials)) yield* credentials.value.revoke(environmentId);
    grants.delete(environmentId);
  });

  const dialWorkers = new Map<string, Fiber.Fiber<unknown>>();
  const reconcilePeer = Effect.fn("PeerSessions.reconcilePeer")(function* (
    environmentId: EnvironmentId,
  ) {
    const env = String(environmentId);
    if (live.has(env)) return;
    const state = attempt.get(env) ?? { attempt: 0, nextAt: 0, lastError: null };
    if (nowMs() < state.nextAt) return;
    const result = yield* Effect.gen(function* () {
      const link = yield* links.resolve(environmentId);
      const wire = yield* dialer.dial({
        environmentId,
        url: wsOrigin(link.url),
        token: link.token,
        callerEnvironmentId: selfId,
      });
      const made = yield* dispatcher
        .make({
          environmentId: env,
          access: link.link.access,
        })
        .pipe(
          Effect.onError(() =>
            Effect.sync(() => wire.close(new Error("Peer credential preparation failed"))),
          ),
        );
      grants.set(env, {
        token: made.token,
        access: link.link.access,
        ...(made.expiresAt === undefined ? {} : { expiresAt: made.expiresAt }),
      });
      yield* attach(environmentId, "outbound", wire, made.call, link.link.access);
    }).pipe(Effect.result);
    if (result._tag === "Success") {
      attempt.set(env, { attempt: 0, nextAt: 0, lastError: null });
    } else {
      const failure = result.failure;
      const nextAttempt = state.attempt + 1;
      const message = messageOf(failure);
      const jitter = yield* Random.next;
      const changed = state.lastError !== message || !offlineSince.has(env);
      attempt.set(env, {
        attempt: nextAttempt,
        nextAt: nowMs() + reconnectDelay(nextAttempt - 1, jitter),
        lastError: message,
      });
      if (!offlineSince.has(env)) offlineSince.set(env, DateTime.formatIso(DateTime.nowUnsafe()));
      if (changed) yield* reportOwnState();
    }
  });
  const reconcile = Effect.gen(function* () {
    const ids = (yield* links.enabled) ? yield* links.ids : [];
    for (const [id, fiber] of dialWorkers) {
      if (!ids.some((environmentId) => environmentId === id)) {
        yield* Fiber.interrupt(fiber);
        dialWorkers.delete(id);
      }
    }
    for (const id of live.keys()) {
      const entry = live.get(id)!;
      if (ids.some((environmentId) => environmentId === id)) entry.linkObserved = true;
      else if (entry.linkObserved) closeLive(id, new Error("The link was removed or disabled"));
    }
    for (const id of ids) {
      if (dialWorkers.has(id)) continue;
      if (!live.has(id) && !offlineSince.has(id)) {
        offlineSince.set(id, DateTime.formatIso(DateTime.nowUnsafe()));
        yield* reportOwnState();
      }
      const fiber = yield* reconcilePeer(id).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Peer dial worker failed", { id, cause })),
        Effect.repeat(Schedule.spaced("1 second")),
        Effect.forkScoped,
      );
      dialWorkers.set(id, fiber);
    }
  });

  let started = false;
  let worker: Fiber.Fiber<unknown> | undefined;
  const start = Effect.gen(function* () {
    if (started) return;
    started = true;
    stopped = false;
    worker = yield* reconcile.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Peer reconciliation failed", cause)),
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.forkScoped,
    );
  }).pipe(Effect.provide(callbackContext));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const entry of live.values()) entry.channel.close(new Error("Peer network stopped"));
      live.clear();
    }),
  );

  const stop = Effect.gen(function* () {
    if (worker) yield* Fiber.interrupt(worker);
    worker = undefined;
    started = false;
    stopped = true;
    for (const fiber of dialWorkers.values()) yield* Fiber.interrupt(fiber);
    dialWorkers.clear();
    for (const id of live.keys()) closeLive(id, new Error("Peer network stopped"));
  });

  const service = PeerSessions.of({
    connected: (environmentId) => Effect.sync(() => live.has(environmentId)),
    status,
    event: (environmentId, name, body) => {
      const entry = live.get(environmentId);
      return entry === undefined ? Effect.succeed(false) : notify(entry, name, body);
    },
    events: Stream.fromPubSub(events),
    facts: (environmentId) => Effect.sync(() => live.get(environmentId)?.facts),
    call,
    openPipe,
    accept: (input) =>
      attach(input.environmentId, input.direction, input.wire, input.call, input.access).pipe(
        Effect.provide(callbackContext),
      ),
    close,
    revoke: (environmentId, notifyPeer) =>
      revoke(environmentId, notifyPeer).pipe(Effect.provide(callbackContext)),
    start,
    stop,
  });
  if (Option.isSome(slot)) {
    slot.value.set(service);
    yield* Effect.addFinalizer(() => Effect.sync(() => slot.value.set(undefined)));
  }
  yield* reportOwnState();
  return service;
});

export const layer = Layer.effect(PeerSessions, make).pipe(Layer.provide(defaultPipeConnector));
