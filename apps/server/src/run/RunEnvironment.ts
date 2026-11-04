// @effect-diagnostics nodeBuiltinImport:off -- Launcher files are generated for the host shell at the runtime installation boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import { ServerConfig } from "../config.ts";
import { shellWord, privateDirectory, runAddress } from "./RunPlatform.ts";
export class RunEnvironmentError extends Schema.TaggedError<RunEnvironmentError>()(
  "RunEnvironmentError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not prepare the thread runtime commands.";
  }
}
export const install = Effect.fn("RunEnvironment.install")(function* () {
  const config = yield* ServerConfig;
  const invocation = yield* resolveSelfInvocation();
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;
  return yield* Effect.tryPromise({
    try: async () => {
      const directory = NodePath.join(config.baseDir, "run", "bin");
      const shims = NodePath.join(config.baseDir, "run", "shims");
      await privateDirectory(directory);
      await privateDirectory(shims);
      const command = [invocation.command, ...selfInvocationArgs(invocation, [])]
        .map(shellWord)
        .join(" ");
      const launcher = `#!/bin/sh\nexec ${command} "$@"\n`;
      await NodeFSP.writeFile(NodePath.join(directory, "t3"), launcher, { mode: 0o700 });
      if (platform === "win32") {
        const windowsCommand = [invocation.command, ...selfInvocationArgs(invocation, [])]
          .map((word) => `"${word.replaceAll('"', '""')}"`)
          .join(" ");
        await NodeFSP.writeFile(
          NodePath.join(directory, "t3.cmd"),
          `@echo off\r\n${windowsCommand} %*\r\n`,
        );
      }
      return {
        directory,
        environment: {
          T3CODE_RUN_SOCKET: runAddress(config.baseDir, platform, userId),
          T3CODE_RUN_SHIMS: shims,
          T3CODE_RUN_BIN: directory,
        },
      };
    },
    catch: (cause) => new RunEnvironmentError({ cause }),
  });
});
