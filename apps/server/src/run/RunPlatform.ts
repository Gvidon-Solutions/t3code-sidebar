/* oxlint-disable t3code/no-global-process-runtime -- This platform boundary supplies native defaults for standalone CLI processes; Effect callers pass injected references. */
// @effect-diagnostics nodeBuiltinImport:off -- Runtime launchers, private IPC addresses and login shells are the run platform boundary.
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { pipeAddress } from "../peer/connection/PeerPlatform.ts";
export const runAddress = (
  baseDir: string,
  platform = process.platform,
  userId = process.getuid?.(),
) => `${pipeAddress(baseDir, platform, userId)}-run`;
export const shellWord = (word: string) => `'${word.replaceAll("'", `'"'"'`)}'`;
export const loginCommand = (
  script: string,
  argument: string,
  platform: string,
  _tty: boolean,
  runtime?: { readonly command: string; readonly entrypoint?: string },
) => {
  if (/win32|windows/i.test(platform)) {
    const escaped = (word: string) => `'${word.replaceAll("'", "''")}'`;
    const invocation = runtime
      ? [
          runtime.command,
          ...(runtime.entrypoint ? [runtime.entrypoint] : []),
          "__run-worker",
          argument,
        ]
      : ["node", "-e", script, "--", argument];
    const body = `& ${invocation.map(escaped).join(" ")}; exit $LASTEXITCODE`;
    return `powershell.exe -NoLogo -EncodedCommand ${Buffer.from(body, "utf16le").toString("base64")}`;
  }
  const invocation = runtime
    ? [
        runtime.command,
        ...(runtime.entrypoint ? [runtime.entrypoint] : []),
        "__run-worker",
        argument,
      ]
        .map(shellWord)
        .join(" ")
    : `node -e ${shellWord(script)} -- ${shellWord(argument)}`;
  const body = `exec ${invocation}`;
  return `exec "$SHELL" -lc ${shellWord(body)}`;
};
export const workerStateRoot = (namespace: string) =>
  NodePath.join(NodeOS.tmpdir(), `t3-run-${process.getuid?.() ?? "user"}`, namespace);
export const namespaceOf = (primaryRoot: string) =>
  NodeCrypto.createHash("sha256").update(primaryRoot).digest("hex").slice(0, 16);
export async function privateDirectory(directory: string) {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(directory);
  if (
    !stat.isDirectory() ||
    (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
  )
    throw new Error("The run directory is not private or owned by this user.");
}

export const guardianAddress = (root: string, id: string) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\t3-run-forward-${namespaceOf(root)}-${id}`
    : NodePath.join(workerStateRoot(namespaceOf(root)), `${id}.forward.sock`);
