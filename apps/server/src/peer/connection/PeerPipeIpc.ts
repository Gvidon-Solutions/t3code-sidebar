import { readLine } from "../../platform/readLine.ts";
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
import {
  pipeAddress,
  preparePipeAddress,
  securePipeAddress,
} from "../../platform/ServerPlatform.ts";
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
    try: async () => {
      const socket = NodeNet.createConnection({
        path: pipeAddress(baseDir, platform, userId),
        allowHalfOpen: true,
      });
      socket.once("connect", () => socket.write(`${encode({ machine, target: "sshd" })}\n`));
      try {
        const response = decodeResponse(
          await readLine(socket, { maxBytes: 8192, timeoutMs: 15000 }),
        );
        if (!response.ok) throw new Error(response.error);
        return socket;
      } catch (error) {
        socket.destroy();
        throw error;
      }
    },
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
    const mesh = yield* MeshLayoutService.MeshLayoutService;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const address = pipeAddress(config.baseDir, platform, userId);
    const resolveMachine = Effect.fn("PeerPipeIpc.resolveMachine")(function* (name: string) {
      const ids = [
        ...new Set([
          ...(yield* links.ids).map(String),
          ...(yield* sessions.status).map((state) => state.environmentId),
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
      const snapshot = yield* mesh.read;
      const matches = ids.filter((id) => {
        const machine = snapshot?.config.machines?.[id];
        return [
          String(id),
          labels.get(id),
          machine?.title,
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
            const controller = new AbortController();
            socket.once("close", () => controller.abort());
            void (async () => {
              try {
                const line = await readLine(socket, { maxBytes: 8192, timeoutMs: 15000 });
                const request = decodeRequest(line);
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
                bridge(socket, stream);
              } catch (error) {
                socket.end(
                  `${encode({ ok: false, error: error instanceof Error ? error.message : "Mesh pipe failed" })}\n`,
                );
              }
            })();
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
