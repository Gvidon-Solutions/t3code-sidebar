/* oxlint-disable t3code/no-global-process-runtime -- Native defaults at the server platform boundary also serve standalone launchers. */
// @effect-diagnostics nodeBuiltinImport:off -- The server platform boundary owns native paths, permissions, shells and private IPC.
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { conflictRoots } from "../replicas/conflictResolution.ts";

export function conflictCopyPath(iso: string, relative: string): string {
  if (!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(iso)) throw new Error("Invalid conflict timestamp");
  if (
    !relative ||
    relative.startsWith("/") ||
    relative.includes("\\") ||
    relative.split("/").some((p) => !p || p === "." || p === "..") ||
    relative.split("/")[0] === ".t3-conflicts"
  )
    throw new Error("Unsafe conflict path");
  return `.t3-conflicts/${iso.replace(/[:.]/g, "-")}/${relative}`;
}

export const sshDirectory = (platform: NodeJS.Platform, environment: NodeJS.ProcessEnv) =>
  platform === "win32"
    ? NodePath.win32.join(environment.ProgramData ?? "C:\\ProgramData", "ssh")
    : "/etc/ssh";

export const pipeAddress = (
  baseDir: string,
  platform: NodeJS.Platform,
  userId: number | undefined,
) => {
  const hash = NodeCrypto.createHash("sha256")
    .update(NodePath.resolve(baseDir))
    .digest("hex")
    .slice(0, 24);
  return platform === "win32"
    ? `\\\\.\\pipe\\t3-mesh-${hash}`
    : NodePath.join(NodeOS.tmpdir(), `t3-mesh-${userId}`, `${hash}.sock`);
};

export async function preparePipeAddress(
  address: string,
  platform: NodeJS.Platform,
  userId: number | undefined,
) {
  if (platform === "win32") return;
  if (userId === undefined) throw new Error("A Unix user id is required for the local mesh socket");
  const directory = NodePath.dirname(address);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== userId || (stat.mode & 0o077) !== 0)
    throw new Error("Local mesh pipe directory is not private");
  try {
    await NodeFSP.unlink(address);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export async function securePipeAddress(address: string, platform: NodeJS.Platform) {
  if (platform !== "win32") await NodeFSP.chmod(address, 0o600);
}

export const nodeCommand = (source: string) =>
  `node -e "eval(Buffer.from('${Buffer.from(source).toString("base64")}','base64').toString())"`;

export function sshArguments(host: string, sshHome?: string): string[] {
  if (!host || host.startsWith("-") || /[\s\0]/.test(host)) throw new Error("Invalid SSH host");
  return [
    ...(sshHome ? ["-F", `${sshHome.replace(/[\\/]$/, "")}/.ssh/config`] : []),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "--",
    host,
  ];
}

export function preserveConflictScript(
  root: string,
  iso: string,
  paths: readonly string[],
): string {
  const copies = conflictRoots(paths).map((relative) => [
    relative,
    conflictCopyPath(iso, relative),
  ]);
  return `const fs = require('node:fs'), path = require('node:path');
const root = fs.realpathSync(${JSON.stringify(root)});
function guard(target) {
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw Error('Outside conflict root');
  let parent = path.dirname(target);
  while (parent !== root) {
    try { if (fs.lstatSync(parent).isSymbolicLink()) throw Error('Symlink parent'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    parent = path.dirname(parent);
  }
}
for (const [relative, copy] of ${JSON.stringify(copies)}) {
  const source = path.resolve(root, relative), destination = path.resolve(root, copy);
  guard(source); guard(destination);
  try { fs.lstatSync(source); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
  try { fs.lstatSync(destination); throw Error('Conflict copy already exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(source, destination);
}`;
}

export function sshWrapper(
  platform: string,
  _executable: string,
  configFile: string,
  program: "ssh" | "scp" = "ssh",
) {
  if (/[\r\n\0]/.test(configFile)) throw new Error("Invalid SSH config path");
  if (platform === "win32")
    return {
      name: `${program}.cmd`,
      contents: `@echo off\r\n${program} -F "${configFile}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
    };
  const quoted = "'" + configFile.replaceAll("'", "'\\''") + "'";
  return { name: program, contents: `#!/bin/sh\nexec ${program} -F ${quoted} "$@"\n` };
}

export function mutagenSshEnvironment(
  platform: string,
  sshHome: string | undefined,
  dataDirectory: string,
) {
  if (!sshHome) return {};
  return platform === "win32"
    ? { HOME: sshHome, USERPROFILE: sshHome }
    : { MUTAGEN_SSH_PATH: `${dataDirectory}/../mesh/ssh/bin` };
}

export function proxyCommand(
  platform: string | undefined,
  runtime: readonly string[],
  environmentId: string,
  baseDir: string,
): string {
  return [...runtime, "mesh", "pipe", environmentId, "--base-dir", baseDir]
    .map((value) => {
      if (/[\r\n\0]/.test(value)) throw new Error("Invalid SSH command argument");
      const escaped = value.replaceAll("%", "%%");
      return platform === "win32" ? `"${escaped}"` : "'" + escaped.replaceAll("'", "'\\''") + "'";
    })
    .join(" ");
}

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

export const executableName = (program: string, platform: string) =>
  platform === "win32" ? `${program}.exe` : program;

export const mutagenTarget = (platform: string, architecture: string) =>
  `${platform === "win32" ? "windows" : platform}_${architecture === "x64" ? "amd64" : architecture}`;

export const agentSkillDirectories = (home: string, platform: string) => {
  const paths = platform === "win32" ? NodePath.win32 : NodePath.posix;
  return [
    ".agents/skills/t3",
    ".claude/skills/t3",
    ".codex/skills/t3",
    ".config/opencode/skills/t3",
  ].map((relative) => paths.join(home, relative));
};
