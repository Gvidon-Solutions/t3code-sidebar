import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { expect, it } from "@effect/vitest";

import * as PeerWire from "./PeerWire.ts";
import { PeerWireDialer, makeChannel, PeerConnectionError } from "./PeerSessions.ts";

const echoLayer = HttpRouter.add(
  "GET",
  "/peer",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const wire = yield* PeerWire.acceptUpgrade(request);
    yield* Effect.promise(async () => {
      for await (const frame of wire.frames) {
        wire.send(`echo:${frame}`);
        if (frame === "close") {
          wire.close();
          break;
        }
      }
      await wire.done;
    });
    return HttpServerResponse.empty();
  }),
);

it.live("dials an upgraded socket and exchanges frames with headers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(
        HttpRouter.serve(echoLayer, { disableListenLog: true }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      );
      const address = HttpServer.formatAddress(
        Context.get(services, HttpServer.HttpServer).address,
      );
      const dialer = yield* PeerWireDialer;
      const wire = yield* dialer.dial({
        environmentId: EnvironmentId.make("cloudbox"),
        url: `${address.replace(/^http/, "ws")}/peer`,
        token: "test-token",
      });
      const frames = wire.frames[Symbol.asyncIterator]();
      wire.send("first");
      expect(yield* Effect.promise(() => frames.next())).toEqual({
        value: "echo:first",
        done: false,
      });
      wire.send("second");
      expect(yield* Effect.promise(() => frames.next())).toEqual({
        value: "echo:second",
        done: false,
      });
      wire.send("close");
      yield* Effect.promise(() => wire.done);
      expect(yield* Effect.promise(() => frames.next())).toEqual({
        value: "echo:close",
        done: false,
      });
      expect(yield* Effect.promise(() => frames.next())).toEqual({
        value: undefined,
        done: true,
      });
    }).pipe(Effect.provide(PeerWire.dialerLayer)),
  ),
);

it.live("fails calls and blocked writes when an upgraded peer stops reading", () =>
  Effect.gen(function* () {
    const stoppedReading = yield* Deferred.make<void>();
    let finish: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const blackhole = HttpRouter.add(
      "GET",
      "/peer",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const socket = yield* request.upgrade;
        const reader = yield* socket.reader;
        yield* reader.pull;
        yield* Deferred.succeed(stoppedReading, undefined);
        yield* Effect.promise(() => closed);
        return HttpServerResponse.empty();
      }),
    );
    const context = yield* Layer.build(
      HttpRouter.serve(blackhole, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.fresh,
      ),
    );
    const address = HttpServer.formatAddress(Context.get(context, HttpServer.HttpServer).address);
    const dialer = yield* PeerWireDialer;
    const wire = yield* dialer.dial({
      environmentId: EnvironmentId.make("cloudbox"),
      url: `${address.replace(/^http/, "ws")}/peer`,
      token: "test-token",
    });
    let now = 0;
    const channel = makeChannel(wire, () => now, {
      call: async () => {
        throw new PeerConnectionError({ reason: "protocol", message: "Unexpected reverse call" });
      },
      event: () => undefined,
      pipe: (_target, stream) =>
        stream.destroy(
          new PeerConnectionError({ reason: "pipe", message: "Unexpected reverse pipe" }),
        ),
      onClose: () => finish?.(),
    });
    const pending = channel.call({ probe: true });
    const refused = expect(pending).rejects.toThrow("heartbeat timed out");
    yield* Deferred.await(stoppedReading);
    const pipe = channel.openPipe("sshd");
    const error = new Promise<Error>((resolve) => pipe.once("error", resolve));
    const written = new Promise<Error | null | undefined>((resolve) =>
      pipe.write(Buffer.alloc(1024 * 1024), resolve),
    );
    now = 15_000;
    channel.tick();
    now = 45_000;
    channel.tick();
    yield* Effect.promise(() => refused);
    expect((yield* Effect.promise(() => written))?.message).toBe("Peer heartbeat timed out");
    expect((yield* Effect.promise(() => error)).message).toBe("Peer heartbeat timed out");
  }).pipe(Effect.scoped, Effect.provide(PeerWire.dialerLayer)),
);
