// @effect-diagnostics nodeBuiltinImport:off -- The test fabricates the wire boundary directly.
import {
  EnvironmentId,
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type PeerLink,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Deferred from "effect/Deferred";
import * as Random from "effect/Random";
import * as TestClock from "effect/testing/TestClock";
import { descriptorOf } from "../PeerLinks.testkit.ts";
import * as Option from "effect/Option";
import { describe, expect, it } from "@effect/vitest";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as PeerLinks from "../PeerLinks.ts";
import * as PeerFacts from "./PeerFacts.ts";
import { MeshLayoutService } from "../../mesh/MeshLayoutService.ts";
import * as PeerSessionsModule from "./PeerSessions.ts";
import {
  type PeerCallBody,
  PeerCallDispatcher,
  PeerSessions,
  type PeerWire,
  PeerWireDialer,
} from "./PeerSessions.ts";

const SELF = EnvironmentId.make("a");
const B = EnvironmentId.make("b");
const C = EnvironmentId.make("c");
const D = EnvironmentId.make("cloudbox:environment");
const E = EnvironmentId.make("e");

const facts: PeerFacts.PeerFacts = {
  version: "1",
  platform: { os: "Linux", arch: "x64", release: "test" },
  user: "tester",
  sshd: { port: 22, hostKeys: ["ssh-ed25519 AAAA"] },
};

class Incoming {
  private readonly items: string[] = [];
  private readonly waiters: Array<(value: string | undefined) => void> = [];
  private ended = false;
  push(value: string) {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.items.push(value);
  }
  end() {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }
  [Symbol.asyncIterator]() {
    return this;
  }
  next(): Promise<IteratorResult<string>> {
    if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) =>
      this.waiters.push((value) =>
        resolve(value === undefined ? { value: undefined, done: true } : { value, done: false }),
      ),
    );
  }
}

const wire = () => {
  const incoming = new Incoming();
  const sent: Array<Record<string, unknown>> = [];
  let closed: Error | undefined;
  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const send = (frame: string) => {
    const parsed = JSON.parse(frame) as Record<string, unknown>;
    sent.push(parsed);
    if (parsed.type === "call") {
      incoming.push(
        JSON.stringify({
          type: "result",
          id: parsed.id,
          body: { text: JSON.stringify(parsed.body), isError: false },
        }),
      );
    }
  };
  return {
    sent,
    get closed() {
      return closed;
    },
    incoming,
    wire: {
      send,
      close: (reason?: Error) => {
        if (closed !== undefined) return;
        closed = reason ?? new Error("closed");
        incoming.end();
        finish?.();
      },
      frames: incoming,
      done,
    } satisfies PeerWire,
  };
};

const link = (environmentId: EnvironmentId): PeerLink => ({
  environmentId,
  label: String(environmentId),
  urls: [`https://${environmentId}.test`],
  access: "full-access",
  linkedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe("2099-01-01"),
  lastReachedAt: null,
  lastError: null,
});

const dependencies = (ids: ReadonlyArray<EnvironmentId>) =>
  Layer.mergeAll(
    Layer.succeed(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(SELF),
        getDescriptor: Effect.succeed(descriptorOf(SELF, "studio")),
      }),
    ),
    Layer.succeed(
      PeerLinks.PeerLinks,
      PeerLinks.PeerLinks.of({
        enabled: Effect.succeed(true),
        link: () => Effect.die("not used"),
        describe: () => Effect.succeedNone,
        list: Effect.succeed([]),
        ids: Effect.succeed(ids),
        acceptGrant: () => Effect.void,
        get: (id) => Effect.succeed(ids.includes(id) ? Option.some(link(id)) : Option.none()),
        unlink: () => Effect.succeed(true),
        resolve: (id) =>
          ids.includes(id)
            ? Effect.succeed({
                link: link(id),
                url: `https://${id}.test`,
                token: "t",
              })
            : Effect.die("unknown link"),
        recordOutcome: () => Effect.void,
      }),
    ),
    Layer.succeed(
      PeerFacts.PeerFactsReporter,
      PeerFacts.PeerFactsReporter.of({ collect: Effect.succeed(facts) }),
    ),
    Layer.succeed(
      PeerCallDispatcher,
      PeerCallDispatcher.of({
        make: ({ environmentId }: { environmentId: string }) =>
          Effect.succeed({
            token: "token",
            call: async (body: PeerCallBody) => ({
              text: JSON.stringify({ environmentId, body }),
              isError: false,
            }),
          }),
      }),
    ),
    Layer.succeed(PeerWireDialer, PeerWireDialer.of({ dial: () => Effect.die("not used") })),
  );

const testLayer = (ids: ReadonlyArray<EnvironmentId>) =>
  PeerSessionsModule.layer.pipe(Layer.provide(dependencies(ids)));

const event = (name: string, body: unknown) => JSON.stringify({ type: "event", name, body });

describe("PeerSessions", () => {
  it.effect(
    "stores reported peer facts and honest connection failures in machine layout entries",
    () =>
      Effect.gen(function* () {
        let config: typeof DEFAULT_SIDEBAR_WORKSPACES_CONFIG = {
          ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
          machines: { ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG.machines, [C]: {} },
        };
        const updates = yield* Queue.unbounded<typeof config>();
        const mesh = Layer.mock(MeshLayoutService)({
          environmentId: SELF,
          read: Effect.sync(() => ({ config, document: {} })),
          edit: (update) =>
            Effect.gen(function* () {
              config = update(config);
              yield* Queue.offer(updates, config);
              return { config, document: {} };
            }),
        });
        const context = yield* Layer.build(
          PeerSessionsModule.layer.pipe(Layer.provide(Layer.merge(dependencies([B]), mesh))),
        );
        const sessions = Context.get(context, PeerSessions);
        const initial = (yield* Queue.take(updates)).machines[SELF]?.reported;
        expect(initial?.user).toBe("tester");
        expect(initial?.connections?.find((state) => state.environmentId === C)).toMatchObject({
          state: "offline",
          lastError: "Waiting for an authenticated peer connection",
        });
        const peer = wire();
        yield* sessions.accept({
          environmentId: B,
          direction: "inbound",
          wire: peer.wire,
          call: async () => ({ text: "{}", isError: false }),
        });
        expect((yield* Queue.take(updates)).machines[SELF]?.reported?.connections?.[0]?.state).toBe(
          "direct",
        );
        peer.incoming.push(event("peer.hello", { facts, links: [SELF] }));
        const reported = (yield* Queue.take(updates)).machines[B]?.reported;
        expect(reported).toMatchObject({
          version: "1",
          platform: facts.platform,
          user: "tester",
          sshd: facts.sshd,
        });
        yield* sessions.close(B, "Fixture tunnel disappeared");
        const state = (yield* Queue.take(updates)).machines[SELF]?.reported?.connections?.[0];
        expect(state).toMatchObject({ state: "offline", lastError: "Fixture tunnel disappeared" });
        expect(state?.offlineSince).toBeTypeOf("string");
      }).pipe(Effect.scoped),
  );

  it.effect("keeps the deterministic side of two simultaneous connections", () =>
    Effect.gen(function* () {
      const sessions = yield* PeerSessions;
      const inbound = wire();
      const outbound = wire();
      yield* sessions.accept({
        environmentId: B,
        direction: "inbound",
        wire: inbound.wire,
        call: async () => ({ text: "{}", isError: false }),
      });
      yield* sessions.accept({
        environmentId: B,
        direction: "outbound",
        wire: outbound.wire,
        call: async () => ({ text: "{}", isError: false }),
      });
      expect(inbound.closed).toBeDefined();
      expect(outbound.closed).toBeUndefined();
      expect((yield* sessions.status).find((s) => s.environmentId === String(B))?.direction).toBe(
        "outbound",
      );
      const secondInbound = wire();
      yield* sessions.accept({
        environmentId: B,
        direction: "inbound",
        wire: secondInbound.wire,
        call: async () => ({ text: "{}", isError: false }),
      });
      expect(secondInbound.closed).toBeDefined();
      expect(outbound.closed).toBeUndefined();
      expect(
        (yield* sessions.status).find((s) => s.environmentId === String(B))?.lastError,
      ).toBeNull();
    }).pipe(Effect.provide(testLayer([B])), Effect.scoped),
  );

  it.effect("sends calls and events over a direct connection", () =>
    Effect.gen(function* () {
      const sessions = yield* PeerSessions;
      const peer = wire();
      yield* sessions.accept({
        environmentId: B,
        direction: "inbound",
        wire: peer.wire,
        call: async () => ({ text: "{}", isError: false }),
      });
      const result = yield* sessions.call({
        environmentId: String(B),
        body: {
          kind: "tool",
          tool: "t3_thread_read",
          arguments: { threadId: "t1" },
          limits: { runtimeMode: "auto", interactionMode: "default" },
        },
      });
      expect(result.isError).toBe(false);
      expect(peer.sent.some((frame) => frame.type === "call")).toBe(true);
      expect(yield* sessions.event(String(B), "layout.push", { x: 1 })).toBe(true);
      expect(
        peer.sent.some((frame) => frame.type === "event" && frame.name === "layout.push"),
      ).toBe(true);
    }).pipe(Effect.provide(testLayer([B])), Effect.scoped),
  );

  it.effect("relays a call and a pipe when the peer has a route", () =>
    Effect.gen(function* () {
      const sessions = yield* PeerSessions;
      const via = wire();
      yield* sessions.accept({
        environmentId: C,
        direction: "inbound",
        wire: via.wire,
        call: async () => ({ text: "{}", isError: false }),
      });
      const updated = yield* sessions.events.pipe(
        Stream.filter((event) => event.name === "peer.routes"),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      via.incoming.push(event("peer.routes", { routes: [String(D)] }));
      yield* Fiber.join(updated);
      const result = yield* sessions.call({
        environmentId: String(D),
        body: {
          kind: "tool",
          tool: "x",
          arguments: {},
          limits: { runtimeMode: "auto", interactionMode: "default" },
        },
      });
      expect(result.isError).toBe(false);
      const relay = via.sent.find((frame) => frame.type === "call")?.body as
        | { kind: string; environmentId: string }
        | undefined;
      expect(relay?.kind).toBe("relay");
      expect(relay?.environmentId).toBe(String(D));
      const stream = yield* sessions.openPipe({ environmentId: String(D), target: "sshd" });
      stream.destroy();
      const open = via.sent.find((frame) => frame.type === "open") as
        | { target: string }
        | undefined;
      expect(JSON.parse(open!.target.slice("relay:".length))).toEqual({
        environmentId: D,
        target: "sshd",
      });
    }).pipe(Effect.provide(testLayer([C, D])), Effect.scoped),
  );

  it.effect("reports direct, relayed and offline peers", () =>
    Effect.gen(function* () {
      const sessions = yield* PeerSessions;
      const direct = wire();
      const via = wire();
      yield* sessions.accept({
        environmentId: B,
        direction: "inbound",
        wire: direct.wire,
        call: async () => ({ text: "{}", isError: false }),
      });
      yield* sessions.accept({
        environmentId: C,
        direction: "inbound",
        wire: via.wire,
        call: async () => ({ text: "{}", isError: false }),
      });
      const updated = yield* sessions.events.pipe(
        Stream.filter((event) => event.name === "peer.routes"),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      via.incoming.push(event("peer.routes", { routes: [String(D)] }));
      yield* Fiber.join(updated);
      const status = yield* sessions.status;
      expect(status.find((s) => s.environmentId === String(B))?.state).toBe("direct");
      expect(status.find((s) => s.environmentId === String(D))).toMatchObject({
        state: "relayed",
        via: String(C),
      });
      expect(status.find((s) => s.environmentId === String(E))?.state).toBe("offline");
      yield* sessions.close(C, "Fixture relay unavailable");
      const lost = (yield* sessions.status).find((state) => state.environmentId === D);
      expect(lost).toMatchObject({ state: "offline", lastError: "Fixture relay unavailable" });
      expect(lost?.offlineSince).toBeTypeOf("string");
    }).pipe(Effect.provide(testLayer([B, C, E])), Effect.scoped),
  );
});

it.effect("backs off each link independently and caps reconnect delay at fifteen seconds", () =>
  Effect.gen(function* () {
    const attempts = yield* Queue.unbounded<number>();
    const blocked = yield* Deferred.make<PeerWire>();
    const peer = wire();
    let nextWire = peer;
    let address = "https://cloudbox.test";
    const attemptedAddresses: string[] = [];
    let count = 0;
    const dialer = Layer.succeed(PeerWireDialer, {
      dial: ({ environmentId, url }) =>
        Effect.gen(function* () {
          if (environmentId === B) return yield* Deferred.await(blocked);
          attemptedAddresses.push(url);
          yield* Queue.offer(attempts, ++count);
          if (count < 7)
            return yield* new PeerSessionsModule.PeerConnectionError({
              reason: "offline",
              message: "fixture peer unavailable",
            });
          return nextWire.wire;
        }),
    });
    const existingLinks = Context.get(
      yield* Layer.build(dependencies([B, C])),
      PeerLinks.PeerLinks,
    );
    const links = Layer.succeed(PeerLinks.PeerLinks, {
      ...existingLinks,
      resolve: (id) =>
        existingLinks.resolve(id).pipe(Effect.map((resolved) => ({ ...resolved, url: address }))),
    });
    const context = yield* Layer.build(
      PeerSessionsModule.layer.pipe(
        Layer.provide(Layer.mergeAll(dependencies([B, C]), dialer, links)),
      ),
    );
    const sessions = Context.get(context, PeerSessions);
    const connected = yield* sessions.events.pipe(
      Stream.filter((event) => event.name === "peer.connected" && event.environmentId === C),
      Stream.runHead,
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* sessions.start;
    expect(yield* Queue.take(attempts)).toBe(1);
    for (const [index, delay] of [1000, 2000, 4000, 8000, 15_000, 15_000].entries()) {
      yield* TestClock.adjust(delay - 1);
      expect(count).toBe(index + 1);
      yield* TestClock.adjust(1);
      expect(yield* Queue.take(attempts)).toBe(index + 2);
    }
    yield* Fiber.join(connected);
    expect(yield* sessions.connected(C)).toBe(true);
    expect(yield* sessions.connected(B)).toBe(false);
    address = "https://cloudbox-new.test";
    nextWire = wire();
    const recovered = yield* sessions.events.pipe(
      Stream.filter((event) => event.name === "peer.connected" && event.environmentId === C),
      Stream.runHead,
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* sessions.close(C, "Network address changed after wake");
    yield* TestClock.adjust(1000);
    expect(yield* Queue.take(attempts)).toBe(8);
    yield* Fiber.join(recovered);
    expect(attemptedAddresses.at(-1)).toBe("wss://cloudbox-new.test/peer");
    expect(yield* sessions.connected(C)).toBe(true);
    yield* sessions.stop;
  }).pipe(
    Effect.scoped,
    Effect.provideService(Random.Random, { nextIntUnsafe: () => 0, nextDoubleUnsafe: () => 1 }),
  ),
);
