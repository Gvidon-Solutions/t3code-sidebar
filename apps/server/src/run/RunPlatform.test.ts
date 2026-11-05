import { expect, it } from "@effect/vitest";
import { loginCommand } from "./RunPlatform.ts";
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
