// @effect-diagnostics nodeBuiltinImport:off -- SSH ProxyCommand reaches the running local server through a private OS socket.
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { EnvironmentId } from "@t3tools/contracts";
import * as ServerConfig from "../../config.ts";
import * as MeshLayoutService from "../../mesh/MeshLayoutService.ts";
import * as PeerLinks from "../PeerLinks.ts";
import { pipeAddress, preparePipeAddress, securePipeAddress } from "./PeerPlatform.ts";
import { PeerSessions, PeerConnectionError } from "./PeerSessions.ts";

const Request = Schema.Struct({ machine: Schema.String, target: Schema.Literal("sshd") });
const Response = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(Request));
const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(Response));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const bridge = (left: NodeStream.Duplex, right: NodeStream.Duplex) => {
  const close = (error?: Error) => {
    left.destroy(error);
    right.destroy(error);
  };
  left.on("error", close);
  right.on("error", close);
  left.on("close", () => {
    if ((!left.readableEnded || !left.writableFinished) && !right.destroyed)
      right.destroy(new Error("Local pipe closed before completion"));
  });
  right.on("close", () => {
    if ((!right.readableEnded || !right.writableFinished) && !left.destroyed)
      left.destroy(new Error("Peer pipe closed before completion"));
  });
  left.pipe(right);
  right.pipe(left);
};

export const connectLocalPipe = Effect.fn("PeerPipeIpc.connect")(function* (
  baseDir: string,
  machine: string,
) {
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;
  return yield* Effect.tryPromise({
    try: () =>
      new Promise<NodeNet.Socket>((resolve, reject) => {
        const socket = NodeNet.createConnection({
          path: pipeAddress(baseDir, platform, userId),
          allowHalfOpen: true,
        });
        let buffer = Buffer.alloc(0);
        const fail = (error: Error) => {
          socket.destroy();
          reject(error);
        };
        const ended = () => fail(new Error("Local mesh server closed the pipe handshake"));
        socket.once("error", fail);
        socket.once("end", ended);
        socket.setTimeout(15_000, () => fail(new Error("Local mesh pipe handshake timed out")));
        socket.once("connect", () => socket.write(`${encode({ machine, target: "sshd" })}\n`));
        const receive = (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          const newline = buffer.indexOf(10);
          if (newline < 0 && buffer.length < 8192) return;
          socket.pause();
          socket.removeListener("data", receive);
          socket.setTimeout(0);
          try {
            if (newline < 0 || newline > 8192) throw new Error("Invalid local mesh pipe response");
            const response = decodeResponse(buffer.subarray(0, newline).toString("utf8"));
            if (!response.ok) throw new Error(response.error);
            socket.removeListener("error", fail);
            socket.removeListener("end", ended);
            if (buffer.length > newline + 1) socket.unshift(buffer.subarray(newline + 1));
            resolve(socket);
          } catch (error) {
            fail(error instanceof Error ? error : new Error("Invalid local mesh pipe response"));
          }
        };
        socket.on("data", receive);
      }),
    catch: (cause) =>
      new PeerConnectionError({
        reason: "pipe",
        message: cause instanceof Error ? cause.message : "Local mesh pipe failed",
        cause,
      }),
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const platform = yield* HostProcess.Platform;
    const userId = yield* HostProcess.UserId;
    const sessions = yield* PeerSessions;
    const links = yield* PeerLinks.PeerLinks;
    const mesh = yield* Effect.serviceOption(MeshLayoutService.MeshLayoutService);
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const address = pipeAddress(config.baseDir, platform, userId);
    const resolveMachine = Effect.fn("PeerPipeIpc.resolveMachine")(function* (name: string) {
      const ids = [
        ...new Set([
          ...(yield* links.ids).map(String),
          ...(yield* sessions.status)
            .filter((state) => state.state !== "offline")
            .map((state) => state.environmentId),
        ]),
      ];
      const labels = new Map(
        yield* Effect.forEach(ids, (id) =>
          links
            .get(EnvironmentId.make(id))
            .pipe(
              Effect.map(
                (link) => [id, Option.isSome(link) ? link.value.label : undefined] as const,
              ),
            ),
        ),
      );
      const snapshot = Option.isSome(mesh) ? yield* mesh.value.read : undefined;
      const matches = ids.filter((id) => {
        const machine = snapshot?.config.machines?.[id];
        return [
          String(id),
          labels.get(id),
          machine?.label,
          machine?.tag,
          ...(machine?.aliases ?? []),
        ].some((value) => value?.toLowerCase() === name.toLowerCase());
      });
      if (matches.length !== 1)
        return yield* new PeerConnectionError({
          reason: "pipe",
          message: matches.length
            ? "Machine name is ambiguous"
            : "No linked machine matches this name",
        });
      return matches[0]!;
    });
    const sockets = new Set<NodeNet.Socket>();
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          await preparePipeAddress(address, platform, userId);
          const server = NodeNet.createServer({ allowHalfOpen: true }, (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.on("error", (error) => {
              void run(Effect.logDebug("Local mesh pipe closed", error));
            });
            let buffer = Buffer.alloc(0);
            socket.setTimeout(15_000, () =>
              socket.destroy(new Error("Local mesh pipe handshake timed out")),
            );
            const receive = (chunk: Buffer) => {
              buffer = Buffer.concat([buffer, chunk]);
              const newline = buffer.indexOf(10);
              if (newline < 0 && buffer.length <= 8192) return;
              socket.pause();
              socket.removeListener("data", receive);
              socket.setTimeout(0);
              const controller = new AbortController();
              socket.once("close", () => controller.abort());
              void (async () => {
                try {
                  if (newline < 0 || newline > 8192)
                    throw new Error("Invalid local mesh pipe request");
                  const request = decodeRequest(buffer.subarray(0, newline).toString("utf8"));
                  const id = await run(resolveMachine(request.machine), {
                    signal: controller.signal,
                  });
                  const stream = await run(
                    sessions.openPipe({
                      environmentId: id,
                      target: request.target,
                      signal: controller.signal,
                    }),
                  );
                  socket.write(`${encode({ ok: true })}\n`);
                  if (buffer.length > newline + 1) socket.unshift(buffer.subarray(newline + 1));
                  bridge(socket, stream);
                } catch (error) {
                  socket.end(
                    `${encode({ ok: false, error: error instanceof Error ? error.message : "Mesh pipe failed" })}\n`,
                  );
                }
              })();
            };
            socket.on("data", receive);
          });
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(address, resolve);
          });
          await securePipeAddress(address, platform);
          return server;
        },
        catch: (cause) =>
          new PeerConnectionError({
            reason: "pipe",
            message: "Local mesh pipe listener could not start",
            cause,
          }),
      }),
      (server) =>
        Effect.promise(async () => {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }),
    );
  }),
);
