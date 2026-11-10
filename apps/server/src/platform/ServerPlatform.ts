import { resolveSshHost } from "@t3tools/shared/meshConfig/sshHost";
/* oxlint-disable t3code/no-global-process-runtime -- Native defaults at the server platform boundary also serve standalone launchers. */
// @effect-diagnostics nodeBuiltinImport:off -- The server platform boundary owns native paths, permissions, shells and private IPC.
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
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

export const nodeCommand = (source: string, platform = "linux") =>
  loginCommand(
    `eval(Buffer.from('${Buffer.from(source).toString("base64")}','base64').toString())`,
    "",
    platform,
    false,
  );

export const sshConfigPath = (home: string) => NodePath.join(home, ".ssh", "config");
export function sshOptions(
  options: {
    readonly configPath?: string | undefined;
    readonly batchMode?: boolean;
    readonly connectTimeoutSeconds?: number;
    readonly aliveIntervalSeconds?: number;
    readonly aliveCount?: number;
    readonly connectionAttempts?: number;
    readonly exitOnForwardFailure?: boolean;
  } = {},
): string[] {
  return [
    ...(options.configPath ? ["-F", options.configPath] : []),
    "-o",
    `BatchMode=${options.batchMode === false ? "no" : "yes"}`,
    "-o",
    `ConnectTimeout=${options.connectTimeoutSeconds ?? 10}`,
    ...(options.connectionAttempts === undefined
      ? []
      : ["-o", `ConnectionAttempts=${options.connectionAttempts}`]),
    "-o",
    `ServerAliveInterval=${options.aliveIntervalSeconds ?? 15}`,
    "-o",
    `ServerAliveCountMax=${options.aliveCount ?? 2}`,
    ...(options.exitOnForwardFailure === undefined
      ? []
      : ["-o", `ExitOnForwardFailure=${options.exitOnForwardFailure ? "yes" : "no"}`]),
  ];
}
export function sshArguments(host: string, sshHome?: string): string[] {
  return [
    ...sshOptions({ configPath: sshHome ? sshConfigPath(sshHome) : undefined }),
    "--",
    resolveSshHost(host),
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
  if (!sshHome && platform !== "win32") return {};
  return {
    MUTAGEN_SSH_PATH: NodePath[platform === "win32" ? "win32" : "posix"].join(
      dataDirectory,
      "../mesh/ssh/bin",
    ),
  };
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
const shellWord = (word: string) => `'${word.replaceAll("'", `'"'"'`)}'`;
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

export function workerPlatform(
  requireNode: NodeRequire,
  namespace: string,
  spawn: (
    command: string,
    args: string[],
    options: import("node:child_process").SpawnOptions,
  ) => import("node:child_process").ChildProcess,
) {
  const path = requireNode("node:path") as typeof import("node:path");
  const os = requireNode("node:os") as typeof import("node:os");
  const fsp = requireNode("node:fs/promises") as typeof import("node:fs/promises");
  const root = path.join(
    os.tmpdir(),
    "t3-run-" + (process.getuid ? process.getuid!() : "user"),
    namespace,
  );
  const address = (id: string) =>
    process.platform === "win32"
      ? "\\\\.\\pipe\\t3-run-" + namespace + "-" + id
      : path.join(root, id + ".sock");
  function privateStat(s: import("node:fs").Stats) {
    return (
      s.isDirectory() &&
      !(process.platform !== "win32" && (s.uid !== process.getuid!() || s.mode & 0o077))
    );
  }
  async function protectSocket(address: string) {
    if (process.platform !== "win32") await fsp.chmod(address, 0o600);
  }
  function groupAlive(pid: number | undefined) {
    if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 0) return false;
    try {
      process.kill(process.platform === "win32" ? pid! : -pid!, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }
  function signalGroup(
    pid: number | undefined,
    sig: NodeJS.Signals,
    emit: (frame: { type: string; message: string }) => unknown,
  ) {
    if (!groupAlive(pid)) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      killer.on("error", (error) => emit({ type: "error", message: error.message }));
    } else {
      try {
        process.kill(-pid!, sig);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
  return { root, address, privateStat, protectSocket, groupAlive, signalGroup };
}

export const executableName = (program: string, platform: string) =>
  platform === "win32" ? `${program}.exe` : program;

export const agentSkillDirectories = (home: string, platform: string) => {
  const paths = platform === "win32" ? NodePath.win32 : NodePath.posix;
  return [
    ".agents/skills/t3",
    ".claude/skills/t3",
    ".codex/skills/t3",
    ".config/opencode/skills/t3",
  ].map((relative) => paths.join(home, relative));
};

export interface MeshServiceInput {
  platform: "linux" | "darwin" | "win32";
  home: string;
  baseDir: string;
  executable: string;
  uid: number;
  user: string;
}
export function meshServicePlan(input: MeshServiceInput) {
  const { platform, home, baseDir, executable, uid, user } = input;
  const paths = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const unit = "t3-mesh";
  const xml = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const systemd = (s: string) => JSON.stringify(s.replaceAll("%", "%%"));
  if (platform === "linux") {
    const root = uid === 0;
    const prefix = root ? [] : ["--user"];
    return {
      files: [
        {
          path: root
            ? `/etc/systemd/system/${unit}.service`
            : paths.join(home, `.config/systemd/user/${unit}.service`),
          content: `[Unit]\nDescription=T3 Mesh\nAfter=network.target\n[Service]\nType=simple\nEnvironment=T3CODE_HOME=${systemd(baseDir)}\nEnvironment=T3_MESH_AGENT_HOME=${systemd(home)}\nExecStart=${systemd(executable)} __service-launcher\nRestart=always\nRestartSec=2\nKillMode=mixed\n[Install]\nWantedBy=${root ? "multi-user.target" : "default.target"}\n`,
        },
      ],
      commands: [
        ...(!root ? [{ command: "loginctl", args: ["enable-linger", user] }] : []),
        { command: "systemctl", args: [...prefix, "daemon-reload"] },
        { command: "systemctl", args: [...prefix, "enable", "--now", `${unit}.service`] },
      ],
    };
  }
  if (platform === "darwin") {
    const label = "com.t3tools.mesh";
    const file = paths.join(home, `Library/LaunchAgents/${label}.plist`);
    return {
      files: [
        {
          path: file,
          content: `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(executable)}</string><string>__service-launcher</string></array><key>EnvironmentVariables</key><dict><key>T3CODE_HOME</key><string>${xml(baseDir)}</string><key>T3_MESH_AGENT_HOME</key><string>${xml(home)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(paths.join(baseDir, "service.log"))}</string><key>StandardErrorPath</key><string>${xml(paths.join(baseDir, "service.log"))}</string></dict></plist>`,
        },
      ],
      commands: [
        {
          command: "launchctl",
          args: ["bootstrap", `gui/${uid}`, file],
          skipIfAccepted: { command: "launchctl", args: ["print", `gui/${uid}/${label}`] },
        },
        { command: "launchctl", args: ["kickstart", `gui/${uid}/${label}`] },
      ],
    };
  }
  const host = paths.join(baseDir, "mesh-service.exe");
  const csharpString = (s: string) => '@"' + s.replaceAll('"', '""') + '"';
  const code = `using System; using System.Diagnostics; using System.ServiceProcess;
public class MeshService : ServiceBase {
Process child; volatile bool stopping;
public MeshService() { ServiceName = "t3-mesh"; }
protected override void OnStart(string[] args) {
var info = new ProcessStartInfo(${csharpString(executable)}, "__service-launcher");
info.UseShellExecute=false; info.WorkingDirectory=${csharpString(home)};
info.EnvironmentVariables["T3CODE_HOME"]=${csharpString(baseDir)};
info.EnvironmentVariables["T3_MESH_AGENT_HOME"]=${csharpString(home)};
info.EnvironmentVariables["HOME"]=${csharpString(home)};
info.EnvironmentVariables["USERPROFILE"]=${csharpString(home)};
child=Process.Start(info); child.Exited += (s,e) => { if(!stopping) { ExitCode=1; Stop(); } }; child.EnableRaisingEvents=true;
}
protected override void OnStop() { stopping=true; if(child!=null && !child.HasExited) { var p=Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + child.Id + " /T /F") { UseShellExecute=false, CreateNoWindow=true }); p.WaitForExit(); } }
public static void Main() { ServiceBase.Run(new MeshService()); }
}`;
  const script = `$ErrorActionPreference='Stop'; if (!(Test-Path -LiteralPath '${host.replaceAll("'", "''")}')) { Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(code).toString("base64")}'))) -ReferencedAssemblies System,System.ServiceProcess -OutputAssembly '${host.replaceAll("'", "''")}' -OutputType WindowsApplication }; if (!(Get-Service -Name t3-mesh -ErrorAction SilentlyContinue)) { New-Service -Name t3-mesh -BinaryPathName '"${host.replaceAll("'", "''")}"' -StartupType Automatic }; & sc.exe failure t3-mesh reset= 86400 actions= restart/2000; if ($LASTEXITCODE -ne 0) { throw 'Service recovery configuration failed' }; & sc.exe failureflag t3-mesh 1; if ($LASTEXITCODE -ne 0) { throw 'Service failure flag configuration failed' }; Start-Service t3-mesh`;
  return {
    files: [],
    commands: [
      {
        command: "powershell.exe",
        args: [
          "-NoLogo",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
      },
    ],
  };
}

export const platformRemoteCommand = (platform: string, argv: readonly string[]) =>
  platform === "win32"
    ? `powershell.exe -NoLogo -NonInteractive -EncodedCommand ${Buffer.from(`& ${argv.map((s) => "'" + s.replaceAll("'", "''") + "'").join(" ")}; exit $LASTEXITCODE`, "utf16le").toString("base64")}`
    : argv.map(shellWord).join(" ");

export const bootstrapUnixProbe = 'uname -s; uname -m; printf "%s\\n" "$HOME"';
export const bootstrapWindowsProbe =
  'powershell.exe -NoLogo -NonInteractive -Command "[Console]::Write($env:USERPROFILE + [char]10 + [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)"';
export function bootstrapFacts(output: string, windows: boolean) {
  const lines = output.trim().split(/\r?\n/);
  const platform = windows
    ? "win32"
    : lines[0] === "Linux"
      ? "linux"
      : lines[0] === "Darwin"
        ? "darwin"
        : undefined;
  if (!platform) throw new Error("Unsupported bootstrap operating system");
  const cpu = lines[windows ? 1 : 1]!;
  const home = lines[windows ? 0 : 2]!;
  if (!home || /[\r\n\0]/.test(home)) throw new Error("Invalid bootstrap home directory");
  const arch = /^(x86_64|amd64|x64)$/i.test(cpu)
    ? "x64"
    : /^(aarch64|arm64)$/i.test(cpu)
      ? "arm64"
      : cpu;
  return { platform, arch, home } as const;
}
export function bootstrapAskpass(platform: string, directory: string) {
  if (platform === "win32") {
    const file = NodePath.win32.join(directory, "askpass.exe");
    const source =
      'using System; class Askpass { static void Main() { Console.Write(Environment.GetEnvironmentVariable("T3_BOOTSTRAP_PASSWORD")); } }';
    const script =
      "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
      Buffer.from(source).toString("base64") +
      "'))) -OutputAssembly '" +
      file.replaceAll("'", "''") +
      "' -OutputType ConsoleApplication";
    return {
      name: "askpass.exe",
      content: "",
      mode: undefined,
      command: {
        command: "powershell.exe",
        args: [
          "-NoLogo",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
      },
    };
  }
  return {
    name: "askpass",
    content: '#!/bin/sh\nprintf "%s" "$T3_BOOTSTRAP_PASSWORD"\n',
    mode: 0o700,
    command: undefined,
  };
}
const powershellScript = (script: string) =>
  `powershell.exe -NoLogo -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
export function bootstrapRemoteRuntime(
  platform: string,
  home: string,
  version: string,
  override?: string,
) {
  const paths = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const baseDir = override ?? paths.join(home, ".t3-mesh");
  if (!paths.isAbsolute(baseDir) || /[\r\n\0]/.test(baseDir))
    throw new Error("Bootstrap base directory must be absolute");
  const destination = paths.join(baseDir, "runtime/versions", version);
  const staging = destination + ".bootstrap";
  const lock = paths.join(baseDir, ".bootstrap-lock");
  const ps = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  const acquire = (token: string) =>
    platform === "win32"
      ? powershellScript(
          `$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Force -Path ${ps(baseDir)} | Out-Null; if ((Test-Path -LiteralPath ${ps(lock)}) -and ((Get-Date)-(Get-Item -LiteralPath ${ps(lock)}).CreationTime).TotalMinutes -gt 20) { Remove-Item -LiteralPath ${ps(lock)} -Recurse -Force }; New-Item -ItemType Directory -Path ${ps(lock)} | Out-Null; [IO.File]::WriteAllText(${ps(paths.join(lock, "owner"))},${ps(token)})`,
        )
      : `set -eu; mkdir -p ${shellWord(baseDir)}; if test -d ${shellWord(lock)} && test -n "$(find ${shellWord(lock)} -maxdepth 0 -mmin +20 -print)"; then rm -rf ${shellWord(lock)}; fi; mkdir ${shellWord(lock)}; printf '%s' ${shellWord(token)} > ${shellWord(paths.join(lock, "owner"))}`;
  const release = (token: string) =>
    platform === "win32"
      ? powershellScript(
          `$ErrorActionPreference='Stop'; if ((Test-Path -LiteralPath ${ps(paths.join(lock, "owner"))}) -and [IO.File]::ReadAllText(${ps(paths.join(lock, "owner"))}) -eq ${ps(token)}) { Remove-Item -LiteralPath ${ps(lock)} -Recurse -Force }`,
        )
      : `if test -f ${shellWord(paths.join(lock, "owner"))} && test "$(cat ${shellWord(paths.join(lock, "owner"))})" = ${shellWord(token)}; then rm -rf ${shellWord(lock)}; fi`;
  const installed =
    platform === "win32"
      ? powershellScript(
          `if (Test-Path -LiteralPath ${ps(paths.join(destination, ".install-complete"))}) { 'installed' }`,
        )
      : `test ! -f ${shellWord(paths.join(destination, ".install-complete"))} || printf installed`;
  const extract =
    platform === "win32"
      ? powershellScript(
          `$ErrorActionPreference='Stop'; if (Test-Path -LiteralPath ${ps(staging)}) { Remove-Item -LiteralPath ${ps(staging)} -Recurse -Force }; if (Test-Path -LiteralPath ${ps(destination)}) { Remove-Item -LiteralPath ${ps(destination)} -Recurse -Force }; New-Item -ItemType Directory -Force -Path ${ps(staging)} | Out-Null; [IO.File]::WriteAllBytes(${ps(paths.join(staging, "archive.zip"))},[Convert]::FromBase64String([Console]::In.ReadToEnd())); & "$env:SystemRoot\\System32\\tar.exe" -xf ${ps(paths.join(staging, "archive.zip"))} -C ${ps(staging)} --strip-components=1; if ($LASTEXITCODE -ne 0) { throw 'Runtime extraction failed' }; Remove-Item -LiteralPath ${ps(paths.join(staging, "archive.zip"))}; [IO.File]::WriteAllText(${ps(paths.join(staging, ".install-complete"))},${ps(version)}); Move-Item -LiteralPath ${ps(staging)} -Destination ${ps(destination)}`,
        )
      : `set -eu; rm -rf ${shellWord(staging)}; mkdir -p ${shellWord(staging)}; base64 -d > ${shellWord(staging + "/archive.tar.gz")}; tar -xzf ${shellWord(staging + "/archive.tar.gz")} -C ${shellWord(staging)} --strip-components=1; rm ${shellWord(staging + "/archive.tar.gz")}; printf '%s\\n' ${shellWord(version)} > ${shellWord(staging + "/.install-complete")}; test ! -e ${shellWord(destination)} || rm -rf ${shellWord(destination)}; mv ${shellWord(staging)} ${shellWord(destination)}`;
  return {
    baseDir,
    destination,
    executable: paths.join(destination, executableName("t3", platform)),
    acquire,
    release,
    installed,
    extract,
  };
}

export function authorizedKeysLocations(
  platform: string,
  home: string,
  environment: NodeJS.ProcessEnv,
  sshdConfig: string,
) {
  const paths = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const files = [paths.join(home, ".ssh/authorized_keys")];
  if (
    platform === "win32" &&
    /Match\s+Group\s+administrators/i.test(sshdConfig) &&
    /administrators_authorized_keys/i.test(sshdConfig)
  )
    files.push(
      paths.join(
        environment.ProgramData ?? "C:\\ProgramData",
        "ssh/administrators_authorized_keys",
      ),
    );
  return files;
}

export function windowsSshWrapperInstall(directory: string, configFile: string) {
  const literal = (value: string) => '@"' + value.replaceAll('"', '""') + '"';
  const commands = ["ssh", "scp"].map((program) => {
    const output = NodePath.win32.join(directory, `${program}.exe`);
    const source = `using System; using System.Text; using System.Diagnostics; using System.IO;
class Transport {
static string Quote(string value) { var b=new StringBuilder(); b.Append((char)34); int slashes=0;
foreach(char c in value) { if(c=='\\\\') { slashes++; continue; } if(c=='"') { b.Append('\\\\',slashes*2+1); b.Append(c); } else { b.Append('\\\\',slashes); b.Append(c); } slashes=0; }
b.Append('\\\\',slashes*2); return b.Append('"').ToString(); }
static int Main(string[] args) { var b=new StringBuilder("-F "); b.Append(Quote(${literal(configFile)})); foreach(string arg in args) { b.Append(' '); b.Append(Quote(arg)); }
var ssh=Path.Combine(Environment.GetEnvironmentVariable("SystemRoot"), @"System32\\OpenSSH\\${program}.exe");
var child=Process.Start(new ProcessStartInfo(ssh,b.ToString()) { UseShellExecute=false }); child.WaitForExit(); return child.ExitCode;
}}
`;
    const script = `$ErrorActionPreference='Stop'; if (!(Test-Path -LiteralPath '${output.replaceAll("'", "''")}')) { Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(source).toString("base64")}'))) -OutputAssembly '${output.replaceAll("'", "''")}.new.exe' -OutputType ConsoleApplication; Move-Item -LiteralPath '${output.replaceAll("'", "''")}.new.exe' -Destination '${output.replaceAll("'", "''")}' -Force }`;
    return {
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
    };
  });
  return commands;
}

const shellPathSetup = `if [ -n "\${T3CODE_RUN_SHIMS:-}" ]; then
  case "$PATH" in "$T3CODE_RUN_SHIMS:$T3CODE_RUN_BIN":*) ;; *) export PATH="$T3CODE_RUN_SHIMS:$T3CODE_RUN_BIN:$PATH" ;; esac
fi
`;
export const bashStartup = `if [ -n "\${T3CODE_RUN_PREVIOUS_BASH_ENV:-}" ] && [ "$T3CODE_RUN_PREVIOUS_BASH_ENV" != "$BASH_ENV" ] && [ -f "$T3CODE_RUN_PREVIOUS_BASH_ENV" ]; then
  . "$T3CODE_RUN_PREVIOUS_BASH_ENV"
fi
${shellPathSetup}`;
export const zshStartup = (file: string) => `typeset _t3_overlay="$ZDOTDIR"
export ZDOTDIR="\${T3CODE_RUN_PREVIOUS_ZDOTDIR:-$HOME}"
if [ -f "$ZDOTDIR/${file}" ]; then . "$ZDOTDIR/${file}"; fi
export T3CODE_RUN_PREVIOUS_ZDOTDIR="$ZDOTDIR"
export ZDOTDIR="$_t3_overlay"
unset _t3_overlay
${shellPathSetup}`;
export function commandShellEnvironment(
  environment: NodeJS.ProcessEnv,
  bashFile: string,
  zshDirectory: string,
  home: string,
) {
  return {
    ...environment,
    T3CODE_RUN_PREVIOUS_BASH_ENV:
      environment.BASH_ENV === bashFile
        ? (environment.T3CODE_RUN_PREVIOUS_BASH_ENV ?? "")
        : (environment.BASH_ENV ?? ""),
    T3CODE_RUN_PREVIOUS_ZDOTDIR:
      environment.ZDOTDIR === zshDirectory
        ? (environment.T3CODE_RUN_PREVIOUS_ZDOTDIR ?? environment.HOME ?? home)
        : (environment.ZDOTDIR ?? environment.HOME ?? home),
    BASH_ENV: bashFile,
    ZDOTDIR: zshDirectory,
  };
}

export const pathDelimiter = (platform: string) => (platform === "win32" ? ";" : ":");
export const virtualEnvironmentPython = (platform: string) =>
  platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";
export function runLauncherFiles(
  platform: string,
  directory: string,
  command: readonly string[],
  environment: Record<string, string>,
) {
  const paths = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const posix = {
    path: paths.join(directory, "t3"),
    content:
      "#!/bin/sh\n" +
      Object.entries(environment)
        .map(([key, value]) => "export " + key + "=" + shellWord(value))
        .join("\n") +
      "\nexec " +
      command.map(shellWord).join(" ") +
      ' "$@"\n',
    mode: 0o700,
  };
  return [
    posix,
    ...(platform === "win32"
      ? [
          {
            path: paths.join(directory, "t3.cmd"),
            content:
              "@echo off\r\n" +
              Object.entries(environment)
                .map(([key, value]) => 'set "' + key + "=" + value.replaceAll("%", "%%") + '"')
                .join("\r\n") +
              "\r\n" +
              command.map((word) => '"' + word.replaceAll('"', '""') + '"').join(" ") +
              " %*\r\n",
            mode: 0o700,
          },
        ]
      : []),
  ];
}
export function runCommandFiles(platform: string, directory: string, name: string) {
  const paths = platform === "win32" ? NodePath.win32 : NodePath.posix;
  return [
    {
      name,
      content:
        "#!/bin/sh\nexec " +
        shellWord(paths.join(directory, "bin/t3")) +
        " __replica-command " +
        shellWord(name) +
        ' "$@"\n',
    },
    ...(platform === "win32"
      ? [
          {
            name: name + ".cmd",
            content:
              '@echo off\r\n"' +
              paths.join(directory, "bin/t3.cmd") +
              '" __replica-command ' +
              name +
              " %*\r\n",
          },
        ]
      : []),
  ];
}

export const MeshTrialFailureExit = Context.Reference<Effect.Effect<void>>(
  "t3/platform/MeshTrialFailureExit",
  {
    defaultValue: () =>
      Effect.sync(() => {
        process.exit(1);
      }),
  },
);
