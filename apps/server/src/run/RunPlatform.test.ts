import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { resolveInvocation, loginCommand } from "../platform/ServerPlatform.ts";
import { commandShellEnvironment } from "./RunShellEnvironment.ts";
it("quotes a login-shell invocation and uses encoded PowerShell with the primary's runtime", () => {
  const posix = loginCommand("source '$value'", "payload", "darwin", false);
  expect(posix).toContain('exec "$SHELL" -lc');
  const windows = loginCommand("unused", "payload", "win32", true, {
    command: "C:\\Program Files\\Node$Work\\node.exe",
    entrypoint: "C:\\T3\\bin.mjs",
  });
  const body = Buffer.from(windows.split(" ").at(-1)!, "base64").toString("utf16le");
  expect(body).toContain("'C:\\Program Files\\Node$Work\\node.exe'");
  expect(body).toContain("'__run-worker' 'payload'");
  expect(body).toContain("exit $LASTEXITCODE");
});
it("preserves shell startup configuration across repeated provider environment merges", () => {
  const first = commandShellEnvironment(
    { HOME: "/home/studio", BASH_ENV: "/custom/bash", ZDOTDIR: "/custom/zsh" },
    "/runtime/bash",
    "/runtime/zsh",
    "/home/studio",
  );
  const second = commandShellEnvironment(first, "/runtime/bash", "/runtime/zsh", "/home/studio");
  expect(second).toEqual(first);
  expect(second.T3CODE_RUN_PREVIOUS_BASH_ENV).toBe("/custom/bash");
  expect(second.T3CODE_RUN_PREVIOUS_ZDOTDIR).toBe("/custom/zsh");
});

it.effect("uses escaped Windows batch invocations for pipes and a command shell for PTYs", () =>
  Effect.gen(function* () {
    const args = ["space value", 'quote"value', "%PATH%", "a&b"];
    const env = { PATH: "C:\\Tools", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
    const batch = yield* resolveInvocation("pnpm", args, env).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => "C:\\Tools\\pnpm.cmd"),
    );
    expect(batch.shell).toBe(true);
    expect(batch.args).toEqual([]);
    expect(batch.command).toContain("pnpm.cmd");
    expect(batch.command).toContain("^&");
    expect(batch.ptyCommand).toBe(env.ComSpec);
    expect(batch.ptyEof).toBe("\x1a\r");
    expect(batch.ptyArgs).toBe(`/d /s /c "${batch.command}"`);
    const native = yield* resolveInvocation("node", args, env).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => "C:\\Tools\\node.exe"),
    );
    expect(native).toEqual({
      command: "C:\\Tools\\node.exe",
      args,
      shell: false,
      ptyCommand: "C:\\Tools\\node.exe",
      ptyArgs: args,
      ptyEof: "\x1a\r",
    });
  }),
);
