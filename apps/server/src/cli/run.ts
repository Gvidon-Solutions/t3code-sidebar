import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";
import { runCli } from "../run/RunCli.ts";
export const runCommand = Command.make("run", {
  command: Argument.String("command").pipe(Argument.variadic),
}).pipe(
  Command.withDescription(
    "Flush and run on a lite replica's primary; run locally elsewhere. Use t3 run --help for execution options.",
  ),
  Command.withHandler(({ command }) => Effect.promise(() => runCli(command))),
);
