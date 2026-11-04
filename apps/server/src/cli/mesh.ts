// @effect-diagnostics nodeBuiltinImport:off -- ProxyCommand connects Node stdin/stdout to the local server's private IPC byte pipe.
import * as NodeStream from "node:stream";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import { Argument, Command } from "effect/cli";
import { connectLocalPipe } from "../peer/connection/PeerPipeIpc.ts";
import { PeerConnectionError } from "../peer/connection/PeerSessions.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";

const bridgeStdio = (stream: NodeStream.Duplex) =>
  new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => {
      stream.destroy();
      reject(error);
    };
    stream.once("error", fail);
    process.stdin.once("error", fail);
    process.stdout.once("error", fail);
    const stop = () => fail(new Error("Mesh pipe interrupted"));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    stream.once("end", () =>
      process.stdout.write("", (error) => (error ? reject(error) : resolve())),
    );
    stream.once("close", () => {
      process.stdin.unpipe(stream);
      stream.unpipe(process.stdout);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      process.stdin.removeListener("error", fail);
      process.stdout.removeListener("error", fail);
      if (!stream.readableEnded) reject(new Error("Mesh pipe closed before EOF"));
    });
    process.stdin.pipe(stream);
    stream.pipe(process.stdout, { end: false });
  });

const pipeCommand = Command.make("pipe", {
  ...authLocationFlags,
  machine: Argument.String("machine"),
}).pipe(
  Command.withDescription(
    "Bridge stdin/stdout through the local mesh server to a machine's loopback sshd.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const level = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, level, { quietLogs: true });
      const stream = yield* connectLocalPipe(config.baseDir, flags.machine);
      yield* Effect.tryPromise({
        try: () => bridgeStdio(stream),
        catch: (cause) =>
          new PeerConnectionError({ reason: "pipe", message: "Mesh pipe failed", cause }),
      });
    }).pipe(Effect.catchCause((cause) => Effect.sync(() => {
      process.stderr.write(`${Cause.pretty(cause)}\n`);
      process.exitCode = 1;
    }))),
  ),
);

export const meshCommand = Command.make("mesh").pipe(Command.withSubcommands([pipeCommand]));
