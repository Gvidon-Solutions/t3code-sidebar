// @effect-diagnostics globalErrorInEffectFailure:off -- Native socket callback errors are mapped to RunIpcError at the Effect boundary.
// @effect-diagnostics nodeBuiltinImport:off -- CLI requests use a private OS socket; the transport delegates all decisions to RunControl.
import * as NodeNet from "node:net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

class RunIpcError extends Schema.TaggedError<RunIpcError>()("RunIpcError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Cannot start the local t3 run endpoint.";
  }
}
import { preparePipeAddress, securePipeAddress } from "../platform/ServerPlatform.ts";
import { ServerConfig } from "../config.ts";
import * as Control from "./RunControl.ts";
import * as Preparation from "./RunPreparation.ts";
import * as SyncLive from "./RunSyncLive.ts";
import { decodeRequest, encodeResponse } from "./RunProtocol.ts";
import { runAddress } from "../platform/ServerPlatform.ts";
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const platform = yield* HostProcess.Platform;
    const userId = yield* HostProcess.UserId;
    const control = yield* Control.RunControl;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const address = runAddress(config.baseDir, platform, userId);
    const sockets = new Set<NodeNet.Socket>();
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          await preparePipeAddress(address, platform, userId);
          const server = NodeNet.createServer((socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.on("error", (error) => {
              void run(Effect.logDebug("Run IPC disconnected", error));
            });
            let input = "";
            socket.setEncoding("utf8");
            socket.setTimeout(5000, () => socket.destroy(new Error("Run IPC handshake timed out")));
            const receive = (chunk: string) => {
              input += chunk;
              const end = input.indexOf("\n");
              if (end < 0 && input.length < 65536) return;
              socket.removeListener("data", receive);
              socket.setTimeout(0);
              const abort = new AbortController();
              socket.once("close", () => abort.abort());
              void (async () => {
                try {
                  if (end < 0 || end > 65536) throw new Error("Invalid run request");
                  const response = await run(control.request(decodeRequest(input.slice(0, end))), {
                    signal: abort.signal,
                  });
                  socket.end(`${encodeResponse(response)}\n`);
                } catch (cause) {
                  void run(Effect.logWarning("Run IPC failed", cause));
                  socket.end(
                    `${encodeResponse({ ok: false, code: 255, message: "The local T3 server could not prepare the command." })}\n`,
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
        catch: (cause) => new RunIpcError({ cause }),
      }),
      (server) =>
        Effect.promise(async () => {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }),
    );
  }),
).pipe(
  Layer.provide(
    Control.layer.pipe(Layer.provide(Preparation.layer.pipe(Layer.provide(SyncLive.layer)))),
  ),
);
