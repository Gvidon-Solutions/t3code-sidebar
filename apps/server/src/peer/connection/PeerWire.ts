// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off -- This module adapts the platform WebSocket at the HTTP boundary.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Socket from "effect/socket/Socket";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import { PeerWireDialer, type PeerWire } from "./PeerSessions.ts";

const MAX_QUEUE_BYTES = 8 * 1024 * 1024;

class FrameQueue implements AsyncIterable<string>, AsyncIterator<string> {
  private readonly items: string[] = [];
  private waiter: ((value: string | undefined) => void) | undefined;
  private ended = false;
  private bytes = 0;

  push(item: string) {
    if (this.ended) return;
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter !== undefined) waiter(item);
    else {
      this.bytes += Buffer.byteLength(item);
      if (this.bytes > MAX_QUEUE_BYTES) throw new Error("Peer socket queue overflowed");
      this.items.push(item);
    }
  }

  end() {
    this.ended = true;
    this.items.length = 0;
    this.bytes = 0;
    this.waiter?.(undefined);
    this.waiter = undefined;
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  next(): Promise<IteratorResult<string>> {
    const item = this.items.shift();
    if (item !== undefined) {
      this.bytes -= Buffer.byteLength(item);
      return Promise.resolve({ value: item, done: false });
    }
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.waiter = (value) =>
        resolve(value === undefined ? { value: undefined, done: true } : { value, done: false });
    });
  }
}

const makeWire = Effect.fn("PeerWire.fromSocket")(function* (socket: Socket.Socket) {
  const scope = yield* Scope.fork(yield* Effect.scope);
  const incoming = new FrameQueue();
  const outgoing: string[] = [];
  let queuedBytes = 0;
  let wake: (() => void) | undefined;
  let closed = false;
  let finish: (() => void) | undefined;
  let requestClose: (() => void) | undefined;
  const closing = new Promise<void>((resolve) => {
    requestClose = resolve;
  });
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const signal = () => {
    const pending = wake;
    wake = undefined;
    pending?.();
  };
  const end = () => {
    closed = true;
    incoming.end();
    signal();
    finish?.();
    finish = undefined;
  };
  const next = () =>
    new Promise<string | undefined>((resolve) => {
      const take = () => {
        const frame = outgoing.shift();
        if (frame !== undefined) queuedBytes -= Buffer.byteLength(frame);
        resolve(frame);
      };
      if (outgoing.length > 0 || closed) take();
      else wake = take;
    });
  const reader = yield* Scope.provide(socket.reader, scope).pipe(
    Effect.onError(() => Scope.close(scope, Exit.void)),
  );
  const writer = yield* Scope.provide(socket.writer, scope);
  yield* Scope.addFinalizer(scope, Effect.sync(end));
  yield* Effect.gen(function* () {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (true) {
      const batch = yield* reader.pull;
      for (const chunk of batch)
        incoming.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
    }
  }).pipe(
    Effect.onExit(() => Effect.sync(end)),
    Effect.catch((error) => Effect.logDebug("Peer socket reader closed", error)),
    Effect.forkScoped,
    Scope.provide(scope),
  );
  yield* Effect.gen(function* () {
    for (;;) {
      const frame = yield* Effect.promise(next);
      if (frame === undefined) break;
      yield* writer.write(frame);
    }
    yield* writer.write(new Socket.CloseEvent(1000));
  }).pipe(
    Effect.onExit(() => Effect.sync(end)),
    Effect.catch((error) => Effect.logDebug("Peer socket writer closed", error)),
    Effect.forkScoped,
    Scope.provide(scope),
  );
  yield* Effect.promise(() => closing).pipe(
    Effect.andThen(Effect.sleep("1 second")),
    Effect.andThen(Scope.close(scope, Exit.void)),
    Effect.forkScoped,
  );
  yield* Effect.promise(() => done).pipe(
    Effect.andThen(Scope.close(scope, Exit.void)),
    Effect.forkScoped,
  );
  return {
    send: (frame: string) => {
      if (closed) throw new Error("Peer socket is closed");
      const bytes = Buffer.byteLength(frame);
      if (queuedBytes + bytes > MAX_QUEUE_BYTES) {
        end();
        throw new Error("Peer socket output queue overflowed");
      }
      outgoing.push(frame);
      queuedBytes += bytes;
      signal();
    },
    close: () => {
      closed = true;
      signal();
      requestClose?.();
    },
    frames: incoming,
    done,
  } satisfies PeerWire;
});

export const acceptUpgrade = Effect.fn("PeerWire.acceptUpgrade")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const socket = yield* request.upgrade.pipe(
    Effect.mapError((cause) => new Error("Peer WebSocket upgrade failed", { cause })),
  );
  return yield* makeWire(socket);
});

export const dialerLayer = Layer.succeed(PeerWireDialer, {
  dial: Effect.fn("PeerWire.dial")((input) =>
    Socket.makeWebSocket(input.url, {
      openTimeout: "10 seconds",
      headers: {
        authorization: `Bearer ${input.token}`,
        ...(input.callerEnvironmentId === undefined
          ? {}
          : { "t3-peer-environment-id": input.callerEnvironmentId }),
      },
    }).pipe(
      Effect.provide(NodeSocket.layerWebSocketConstructorWS),
      Effect.flatMap(makeWire),
      Effect.mapError(
        (cause) =>
          new Error(`Could not connect to ${input.environmentId}: ${cause.message}`, { cause }),
      ),
    ),
  ),
});
