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
export const loginCommand = (script: string, argument: string, platform: string, tty: boolean) => {
  if (/win32|windows/i.test(platform)) {
    const escaped = (word: string) => `'${word.replaceAll("'", "''")}'`;
    return `powershell.exe -NoLogo -Command "& node -e ${escaped(script)} -- ${escaped(argument)}; exit $LASTEXITCODE"`;
  }
  const body = `${tty ? "stty raw -echo; " : ""}exec node -e ${shellWord(script)} -- ${shellWord(argument)}`;
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
