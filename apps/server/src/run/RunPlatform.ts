/* oxlint-disable t3code/no-global-process-runtime -- This platform boundary supplies native defaults for standalone CLI processes; Effect callers pass injected references. */
// @effect-diagnostics nodeBuiltinImport:off -- Runtime launchers, private IPC addresses and login shells are the run platform boundary.
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
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

export const resolveInvocation = Effect.fn("RunPlatform.resolveInvocation")(function* (
  command: string,
  args: readonly string[],
  suppliedEnvironment?: NodeJS.ProcessEnv,
) {
  const environment = suppliedEnvironment ?? (yield* HostProcess.Environment);
  const resolved = yield* resolveSpawnCommand(command, args, { env: environment });
  const platform = yield* HostProcess.Platform;
  const ptyEof = platform === "win32" ? "\x1a\r" : "\x04";
  if (platform === "win32" && resolved.shell) {
    const shell =
      Object.entries(environment).find(([key]) => key.toUpperCase() === "COMSPEC")?.[1] ??
      "cmd.exe";
    return { ...resolved, ptyCommand: shell, ptyArgs: `/d /s /c "${resolved.command}"`, ptyEof };
  }
  return { ...resolved, ptyCommand: resolved.command, ptyArgs: resolved.args, ptyEof };
});
// Native child and PTY constructors need synchronous resolution after the login profile loads.
export const nativeInvocation = (
  command: string,
  args: readonly string[],
  environment = process.env,
) => Effect.runSync(resolveInvocation(command, args, environment));

export const WORKER_PLATFORM_SOURCE = String.raw`
const root = path.join(os.tmpdir(), 't3-run-' + (process.getuid ? process.getuid() : 'user'), c.namespace);
const address = id => process.platform === 'win32' ? '\\\\.\\pipe\\t3-run-' + c.namespace + '-' + id : path.join(root, id + '.sock');
function privateStat(s) { return s.isDirectory() && !(process.platform !== 'win32' && (s.uid !== process.getuid() || (s.mode & 0o077))); }
async function protectSocket(address) { if (process.platform !== 'win32') await fsp.chmod(address, 0o600); }
function signalGroup(pid, sig, emit) {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {stdio:'ignore'});
    killer.on('error', error => emit({type:'error',message:error.message}));
  } else {
    try { process.kill(-pid,sig); } catch(error) { if (error.code !== 'ESRCH') throw error; }
  }
}
`;
