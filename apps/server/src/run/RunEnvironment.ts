// @effect-diagnostics nodeBuiltinImport:off -- Launcher files are generated for the host shell at the runtime installation boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import { ServerConfig } from "../config.ts";
import { shellWord, privateDirectory, runAddress } from "./RunPlatform.ts";
import { bashStartup, zshStartup, commandShellEnvironment } from "./RunShellEnvironment.ts";

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
  const home = yield* HostProcess.HomeDirectory;
  return yield* Effect.tryPromise({
    try: async () => {
      const directory = NodePath.join(config.baseDir, "run", "bin");
      const shims = NodePath.join(config.baseDir, "run", "shims");
      await privateDirectory(directory);
      await privateDirectory(shims);
      const bashFile = NodePath.join(config.baseDir, "run", "bash-env");
      const zshDirectory = NodePath.join(config.baseDir, "run", "zsh");
      await privateDirectory(zshDirectory);
      await NodeFSP.writeFile(bashFile, bashStartup, { mode: 0o600 });
      for (const file of [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"])
        await NodeFSP.writeFile(NodePath.join(zshDirectory, file), zshStartup(file), {
          mode: 0o600,
        });
      const command = [invocation.command, ...selfInvocationArgs(invocation, [])]
        .map(shellWord)
        .join(" ");
      const launcherEnvironment = {
        T3CODE_RUN_SOCKET: runAddress(config.baseDir, platform, userId),
        T3CODE_RUN_MANIFEST: NodePath.join(config.baseDir, "run", "manifest.json"),
        T3CODE_RUN_SHIMS: shims,
        T3CODE_RUN_BIN: directory,
      };
      const launcher = `#!/bin/sh\n${Object.entries(launcherEnvironment)
        .map(([key, value]) => `export ${key}=${shellWord(value)}`)
        .join("\n")}\nexec ${command} "$@"\n`;
      await NodeFSP.writeFile(NodePath.join(directory, "t3"), launcher, { mode: 0o700 });
      if (platform === "win32") {
        const windowsCommand = [invocation.command, ...selfInvocationArgs(invocation, [])]
          .map((word) => `"${word.replaceAll('"', '""')}"`)
          .join(" ");
        await NodeFSP.writeFile(
          NodePath.join(directory, "t3.cmd"),
          `@echo off\r\n${Object.entries(launcherEnvironment)
            .map(([key, value]) => `set "${key}=${value.replaceAll("%", "%%")}"`)
            .join("\r\n")}\r\n${windowsCommand} %*\r\n`,
        );
      }
      await NodeFSP.writeFile(
        NodePath.join(config.baseDir, "run", "opencode-plugin.mjs"),
        `export const T3RunShellEnvironment = async () => ({
  "shell.env": async (_input, output) => {
    const shimDirectory = process.env.T3CODE_RUN_SHIMS;
    if (shimDirectory) output.env.PATH = shimDirectory + "${platform === "win32" ? ";" : ":"}" + (output.env.PATH || process.env.PATH || "");
  }
});\n`,
      );
      return {
        directory,
        mapEnvironment: (environment: NodeJS.ProcessEnv) =>
          commandShellEnvironment(environment, bashFile, zshDirectory, home),
        environment: {
          T3CODE_RUN_SOCKET: runAddress(config.baseDir, platform, userId),
          T3CODE_RUN_SHIMS: shims,
          T3CODE_RUN_BIN: directory,
          T3CODE_RUN_DELIMITER: platform === "win32" ? ";" : ":",
          T3CODE_RUN_MANIFEST: NodePath.join(config.baseDir, "run", "manifest.json"),
          T3CODE_RUN_OPENCODE_PLUGIN: NodePath.join(config.baseDir, "run", "opencode-plugin.mjs"),
        },
      };
    },
    catch: (cause) => new RunEnvironmentError({ cause }),
  });
});
