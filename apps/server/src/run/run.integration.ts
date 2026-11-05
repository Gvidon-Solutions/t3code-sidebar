// @effect-diagnostics nodeBuiltinImport:off -- This explicit integration runner owns real Docker, sshd, Mutagen and runtime CLI subprocesses.
// @effect-diagnostics globalErrorInEffectFailure:off -- Native fixture failures are preserved at the test runner boundary.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ReplicaError, SidebarWorkspacesConfig } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import { ProjectReplicaService } from "../replicas/ProjectReplicaService.ts";
import { ReplicaRuntime } from "../replicas/ReplicaRuntime.ts";
import { decodeSessions } from "../replicas/MutagenRunner.ts";
import * as RunIpc from "./RunIpc.ts";
import * as RunEnvironment from "./RunEnvironment.ts";
import { awaitForwardingStop } from "./RunGuardianControl.ts";
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const requireNative = NodeModule.createRequire(import.meta.url);
const repo = NodePath.resolve(import.meta.dirname, "../../../..");
const bin = NodePath.join(repo, "apps/server/src/bin.ts");
const runtimeCommand = process.env.R1_RUN_BINARY ?? process.execPath;
const runtimeArgs = process.env.R1_RUN_BINARY ? [] : [bin];
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "R1-run-integration-"));
const primary = NodePath.join(root, "primary"),
  replica = NodePath.join(root, "replica");
const container = `r1-run-${NodeCrypto.randomUUID().slice(0, 8)}`;
let daemon: NodeChildProcess.ChildProcess | undefined;
let disposeRuntime: (() => Promise<void>) | undefined;
const daemonEnv = {
  ...process.env,
  HOME: NodePath.join(root, "client-home"),
  MUTAGEN_DATA_DIRECTORY: NodePath.join(root, "mutagen"),
  MUTAGEN_SSH_PATH: NodePath.join(root, "ssh-bin"),
};
const sshConfig = NodePath.join(root, "ssh-config");
const session = `R1-${NodeCrypto.randomUUID().slice(0, 8)}`;
const pairs = new Set<NodeNet.Socket>();
let blocked = false;
const proxy = NodeNet.createServer();
async function port() {
  const server = NodeNet.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No port");
  await new Promise<void>((r) => server.close(() => r()));
  return address.port;
}
async function command(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  return (await execFile(file, [...args], { env, maxBuffer: 16 * 1024 * 1024 })).stdout;
}
const mutagen = (...args: string[]) => command("mutagen", args, daemonEnv);
function launch(args: readonly string[], env: NodeJS.ProcessEnv, cwd = replica) {
  const child = NodeChildProcess.spawn(runtimeCommand, [...runtimeArgs, "run", ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "",
    stderr = "";
  const waiters = new Set<{ text: string; resolve: () => void; reject: (error: Error) => void }>();
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (const waiter of waiters)
      if (stdout.includes(waiter.text)) {
        waiters.delete(waiter);
        waiter.resolve();
      }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        for (const waiter of waiters)
          waiter.reject(Error(`Exited before ${waiter.text}: ${stderr}`));
        resolve({ code, stdout, stderr });
      });
    },
  );
  return {
    child,
    result,
    ready: (text: string) =>
      stdout.includes(text)
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => waiters.add({ text, resolve, reject })),
  };
}
const report = (name: string, result: unknown) =>
  process.stdout.write(name + " " + JSON.stringify(result) + "\n");
try {
  await Promise.all(
    [
      primary,
      replica,
      NodePath.join(root, "client-home"),
      NodePath.join(root, "ssh-bin"),
      NodePath.join(root, "home/.local/bin"),
      NodePath.join(root, `home/.nvm/versions/node/v${process.versions.node}/bin`),
      NodePath.join(root, "mutagen"),
    ].map((p) => NodeFSP.mkdir(p, { recursive: true, mode: 0o700 })),
  );
  await command("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    NodePath.join(root, "host-key"),
  ]);
  await command("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    NodePath.join(root, "client-key"),
  ]);
  await NodeFSP.copyFile(
    NodePath.join(root, "client-key.pub"),
    NodePath.join(root, "authorized_keys"),
  );
  await NodeFSP.copyFile(
    NodePath.join(process.env.NVM_DIR ?? NodePath.join(NodeOS.homedir(), ".nvm"), "nvm.sh"),
    NodePath.join(root, "home/.nvm/nvm.sh"),
  );
  await NodeFSP.symlink(
    "/usr/local/bin/node",
    NodePath.join(root, `home/.nvm/versions/node/v${process.versions.node}/bin/node`),
  );
  const uv = (await command("sh", ["-c", "command -v uv"])).trim();
  await NodeFSP.copyFile(uv, NodePath.join(root, "home/.local/bin/uv"));
  await NodeFSP.chmod(NodePath.join(root, "home/.local/bin/uv"), 0o700);
  await NodeFSP.writeFile(
    NodePath.join(root, "home/.bash_profile"),
    'export NVM_DIR="$HOME/.nvm"\n. "$NVM_DIR/nvm.sh" --no-use\nnvm use --silent v26.12.1\nexport PATH="$HOME/.local/bin:$PATH"\nexport R1_LOGIN_PROFILE=loaded\n',
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "sshd_config"),
    `Port 22\nListenAddress 0.0.0.0\nHostKey ${root}/host-key\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${root}/authorized_keys\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers studio\nSetEnv HOME=${root}/home PATH=/usr/bin:/bin\nSubsystem sftp internal-sftp\n`,
  );
  const sshPort = await port(),
    proxyPort = await port(),
    childPort = await port();
  await command("docker", [
    "run",
    "-d",
    "--name",
    container,
    "--user",
    "0",
    "--publish",
    `127.0.0.1:${sshPort}:22`,
    "--publish",
    `127.0.0.1:${childPort}:45555`,
    "--mount",
    `type=bind,src=${root},dst=${root}`,
    "--mount",
    `type=bind,src=${repo},dst=${repo},readonly`,
    process.env.R1_SSH_IMAGE ?? "t3-run-sshd-test:local",
    "-f",
    NodePath.join(root, "sshd_config"),
  ]);
  await command("docker", [
    "exec",
    "--user",
    "0",
    container,
    "usermod",
    "-u",
    String(process.getuid?.() ?? 1000),
    "-d",
    NodePath.join(root, "home"),
    "studio",
  ]);
  const logs = NodeChildProcess.spawn("docker", ["logs", "--follow", container], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const ready = (chunk: Buffer) => {
      if (chunk.toString().includes("Server listening")) {
        logs.kill("SIGTERM");
        resolve();
      }
    };
    logs.stdout.on("data", ready);
    logs.stderr.on("data", ready);
    logs.once("error", reject);
    logs.once("close", (code) => {
      if (code !== null && code !== 0) reject(Error("sshd did not start"));
    });
  });
  proxy.on("connection", (socket) => {
    if (blocked) {
      socket.destroy();
      return;
    }
    const upstream = NodeNet.connect(sshPort, "127.0.0.1");
    pairs.add(socket);
    pairs.add(upstream);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => {
      pairs.delete(socket);
      upstream.destroy();
    });
    upstream.on("close", () => {
      pairs.delete(upstream);
      socket.destroy();
    });
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  await new Promise<void>((r) => proxy.listen(proxyPort, "127.0.0.1", r));
  const hostKey = await NodeFSP.readFile(NodePath.join(root, "host-key.pub"), "utf8");
  await NodeFSP.writeFile(
    NodePath.join(root, "known_hosts"),
    `[127.0.0.1]:${proxyPort} ${hostKey}`,
  );
  await NodeFSP.writeFile(
    sshConfig,
    `Host t3-cloudbox\n HostName 127.0.0.1\n Port ${proxyPort}\n User studio\n IdentityFile ${root}/client-key\n UserKnownHostsFile ${root}/known_hosts\n StrictHostKeyChecking yes\n IdentitiesOnly yes\n`,
  );
  for (const tool of ["ssh", "scp"]) {
    const executable = (await command("sh", ["-c", `command -v ${tool}`])).trim();
    await NodeFSP.writeFile(
      NodePath.join(root, "ssh-bin", tool),
      `#!/bin/sh\nexec '${executable}' -F '${sshConfig}' "$@"\n`,
      { mode: 0o700 },
    );
  }
  const readySocket = new Promise<void>((resolve, reject) => {
    const watcher = NodeFS.watch(NodePath.join(root, "mutagen"), { recursive: true }, () => {
      if (NodeFS.existsSync(NodePath.join(root, "mutagen/daemon/daemon.sock"))) {
        watcher.close();
        resolve();
      }
    });
    watcher.on("error", reject);
  });
  daemon = NodeChildProcess.spawn("mutagen", ["daemon", "run"], {
    env: daemonEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  daemon.stderr?.pipe(NodeFS.createWriteStream(NodePath.join(root, "daemon.log"), { mode: 0o600 }));
  await readySocket;
  await NodeFSP.writeFile(NodePath.join(primary, "input.txt"), "initial\n");
  await mutagen(
    "sync",
    "create",
    "--name",
    session,
    "--sync-mode",
    "two-way-safe",
    "--ignore-vcs",
    "--ignore",
    "/dist",
    "--ignore",
    "/.t3-conflicts",
    `t3-cloudbox:${primary}`,
    replica,
  );
  await mutagen("sync", "flush", session);
  const inspect = () =>
    Effect.tryPromise({
      try: () => mutagen("sync", "list", session, "--template", "{{json .}}"),
      catch: (cause) =>
        new ReplicaError({ reason: "mutagen", message: "Test session query failed.", cause }),
    }).pipe(
      Effect.flatMap(decodeSessions),
      Effect.mapError(
        (cause) =>
          new ReplicaError({ reason: "mutagen", message: "Test session query failed.", cause }),
      ),
    );
  const syncApi = {
    flush: () =>
      Effect.tryPromise({
        try: async (signal) => {
          await execFile("mutagen", ["sync", "flush", session], { env: daemonEnv, signal });
          return true;
        },
        catch: (cause) =>
          new ReplicaError({ reason: "mutagen", message: "Test session flush failed.", cause }),
      }),
    conflicts: () =>
      inspect().pipe(
        Effect.map((rows) => rows.flatMap((row) => row.conflicts?.map((c) => c.root) ?? [])),
      ),
    problems: () =>
      inspect().pipe(
        Effect.map((rows) =>
          rows.flatMap((row) =>
            [row.alpha, row.beta].flatMap((endpoint) =>
              [...(endpoint.scanProblems ?? []), ...(endpoint.transitionProblems ?? [])].map(
                (p) => `${p.path}: ${p.error}`,
              ),
            ),
          ),
        ),
      ),
  };
  const config = Schema.decodeSync(SidebarWorkspacesConfig)({
    projectTitles: { sample: "R1 Sample" },
    projectMounts: {
      sample: [
        {
          environmentId: "laptop",
          path: replica,
          role: "replica",
          transport: "mutagen",
          source: "cloud",
          createdAt: "",
        },
        { environmentId: "cloud", path: primary, role: "primary", transport: "git", createdAt: "" },
      ],
    },
  });
  const snapshot = {
    config,
    document: { "mesh.machineBinding/cloudbox": { v: "cloud", h: "0000000000001.00000.laptop" } },
  };
  const mesh = Layer.mock(MeshLayoutService)({
    environmentId: "laptop",
    read: Effect.succeed(snapshot),
    changes: Stream.succeed(snapshot),
  });
  const replicas = Layer.mock(ProjectReplicaService)(syncApi);
  const runtimeLayer = Layer.effect(
    ReplicaRuntime,
    Effect.map(ProjectReplicaService, (service) => ({ get: Effect.succeed(service) })),
  ).pipe(Layer.provide(replicas));
  const runtimeInfo = {
    command: process.env.R1_RUN_BINARY ?? "/usr/local/bin/node",
    ...(process.env.R1_RUN_BINARY ? {} : { entrypoint: bin }),
    ptyModule: requireNative.resolve("node-pty"),
  };
  const peers = Layer.mock(PeerMcpClient)({
    connectionAvailable: () => Effect.succeed(true),
    call: () => Effect.succeed(runtimeInfo),
  });
  const base = Layer.mergeAll(
    NodeServices.layer,
    ServerConfig.layerTest(replica, NodePath.join(root, "runtime")).pipe(
      Layer.provide(NodeServices.layer),
    ),
    mesh,
    runtimeLayer,
    peers,
    Layer.mock(PeerLinks)({}),
  );
  const managed = ManagedRuntime.make(RunIpc.layer.pipe(Layer.provideMerge(base)));
  disposeRuntime = () => managed.dispose();
  await NodeFSP.mkdir(NodePath.join(root, "client-home/.ssh"), { recursive: true });
  await NodeFSP.copyFile(sshConfig, NodePath.join(root, "client-home/.ssh/config"));
  const installed = await managed.runPromise(
    RunEnvironment.install().pipe(
      Effect.provideService(HostProcess.Arguments, [runtimeCommand, ...runtimeArgs]),
      Effect.provideService(HostProcess.ExecutablePath, runtimeCommand),
      Effect.provideService(HostProcess.IsExecutable, Boolean(process.env.R1_RUN_BINARY)),
      Effect.provideService(HostProcess.Environment, {
        ...process.env,
        T3_MESH_SSH_HOME: NodePath.join(root, "client-home"),
      }),
    ),
  );
  await managed.runPromise(Effect.void);
  const env = installed.mapEnvironment({
    ...process.env,
    ...installed.environment,
    PATH: `${installed.directory}${NodePath.delimiter}${process.env.PATH ?? ""}`,
  });
  const run = async (name: string, args: readonly string[], cwd = replica) => {
    const result = await launch(args, env, cwd).result;
    report(name, result);
    return result;
  };
  NodeAssert.equal(
    (
      await run(
        "local_exit",
        [
          "--",
          process.execPath,
          "-e",
          "process.stdout.write('local');process.stderr.write('err');process.exitCode=19",
        ],
        root,
      )
    ).code,
    19,
  );
  NodeAssert.equal(
    (
      await run("login_environment", [
        "--",
        "node",
        "-e",
        "console.log(process.env.R1_LOGIN_PROFILE);console.log(require('child_process').execFileSync('uv',['--version']).toString().trim());console.log(process.version)",
      ])
    ).code,
    0,
  );
  await NodeFSP.mkdir(NodePath.join(replica, "nested"));
  await mutagen("sync", "flush", session);
  const mapping = await run(
    "mapping_stream_exit",
    [
      "--",
      "node",
      "-e",
      "console.log(process.cwd());console.error(process.cwd()+'/err');process.exitCode=23",
    ],
    NodePath.join(replica, "nested"),
  );
  NodeAssert.equal(mapping.code, 23);
  NodeAssert.match(mapping.stdout, new RegExp(replica + "/nested"));
  NodeAssert.doesNotMatch(mapping.stdout, new RegExp(primary));
  const output = await run("flush_ignored", [
    "--",
    "node",
    "-e",
    "require('fs').writeFileSync('output.txt','returned');require('fs').mkdirSync('dist');require('fs').writeFileSync('dist/built.txt','stays')",
  ]);
  NodeAssert.equal(output.code, 0);
  NodeAssert.equal(
    await NodeFSP.readFile(NodePath.join(replica, "output.txt"), "utf8"),
    "returned",
  );
  NodeAssert.match(output.stderr, /dist\/built.txt stayed on cloudbox/);
  await NodeAssert.rejects(NodeFSP.access(NodePath.join(replica, "dist/built.txt")));
  const concurrent = await Promise.all([
    run("concurrent_one", ["--", "node", "-e", "console.log('one')"]),
    run("concurrent_two", ["--", "node", "-e", "console.log('two')"]),
  ]);
  NodeAssert.ok(concurrent.every((r) => r.code === 0));
  daemon.kill("SIGSTOP");
  try {
    const timeout = await run("flush_timeout", [
      "--timeout",
      "300ms",
      "--",
      "node",
      "-e",
      "require('fs').writeFileSync('must-not-run','bad')",
    ]);
    NodeAssert.equal(timeout.code, 75);
    NodeAssert.match(timeout.stderr, /timed out/);
  } finally {
    daemon.kill("SIGCONT");
  }
  await NodeAssert.rejects(NodeFSP.access(NodePath.join(primary, "must-not-run")));
  await mutagen("sync", "flush", session);
  await mutagen("sync", "pause", session);
  await NodeFSP.writeFile(NodePath.join(primary, "input.txt"), "primary edit");
  await NodeFSP.writeFile(NodePath.join(replica, "input.txt"), "replica edit");
  await mutagen("sync", "resume", session);
  const conflict = await run("conflict_before_run", [
    "--",
    "node",
    "-e",
    "require('fs').writeFileSync('must-not-run','bad')",
  ]);
  NodeAssert.equal(conflict.code, 75);
  NodeAssert.match(conflict.stderr, /input.txt/);
  await NodeAssert.rejects(NodeFSP.access(NodePath.join(primary, "must-not-run")));
  await mutagen("sync", "terminate", session);
  await NodeFSP.mkdir(NodePath.join(replica, ".t3-conflicts", "saved"), { recursive: true });
  await NodeFSP.copyFile(
    NodePath.join(replica, "input.txt"),
    NodePath.join(replica, ".t3-conflicts", "saved", "input.txt"),
  );
  await NodeFSP.writeFile(NodePath.join(replica, "input.txt"), "primary edit");
  await mutagen(
    "sync",
    "create",
    "--name",
    session,
    "--sync-mode",
    "two-way-safe",
    "--ignore-vcs",
    "--ignore",
    "/dist",
    "--ignore",
    "/.t3-conflicts",
    `t3-cloudbox:${primary}`,
    replica,
  );
  await mutagen("sync", "flush", session);
  const tty = requireNative("node-pty") as typeof import("node-pty");
  const terminal = tty.spawn(
    runtimeCommand,
    [
      ...runtimeArgs,
      "run",
      "--",
      "node",
      "-e",
      "console.log('TTY='+process.stdin.isTTY+':'+process.stdout.isTTY)",
    ],
    { cwd: replica, env, name: "xterm", cols: 80, rows: 24 },
  );
  let ttyOutput = "";
  terminal.onData((data) => (ttyOutput += data));
  const ttyCode = await new Promise<number>((resolve) =>
    terminal.onExit((e) => resolve(e.exitCode)),
  );
  report("tty", { code: ttyCode, stdout: ttyOutput });
  NodeAssert.equal(ttyCode, 0);
  NodeAssert.match(ttyOutput, /TTY=true:true/);
  const forwardPort = await port();
  const serverCode = `require('net').createServer(s=>s.end('port-ok')).listen(${forwardPort},'127.0.0.1',()=>console.log('SERVER_READY'))`;
  const background = await run("background_start", [
    "--bg",
    "--ports",
    String(forwardPort),
    "--",
    "node",
    "-e",
    serverCode,
  ]);
  NodeAssert.equal(background.code, 0);
  const id = background.stdout.trim();
  NodeAssert.match(id, /^[a-f0-9-]{36}$/);
  NodeAssert.match((await run("background_list", ["--list"])).stdout, new RegExp(id));
  const follow = launch(["--logs", id, "--follow"], env);
  await follow.ready("SERVER_READY");
  const served = await new Promise<string>((resolve, reject) => {
    const socket = NodeNet.connect(forwardPort, "127.0.0.1");
    let text = "";
    socket.on("data", (data) => (text += data));
    socket.once("end", () => resolve(text));
    socket.once("error", reject);
  });
  NodeAssert.equal(served, "port-ok");
  report("background_forward", served);
  NodeAssert.equal((await run("background_stop", ["--stop", id])).code, 0);
  const followResult = await follow.result;
  report("background_follow", followResult);
  NodeAssert.equal(followResult.code, 143);
  const bound = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    bound.once("error", reject);
    bound.listen(forwardPort, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve) => bound.close(() => resolve()));
  report("forward_released", true);
  for (const mode of ["interrupt", "tty-interrupt", "terminate", "cut"]) {
    const childCode =
      "require('net').createServer(()=>{}).listen(45555,'0.0.0.0',()=>console.log('TREE_READY'))";
    const parentCode = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;
    const terminal =
      mode === "tty-interrupt"
        ? tty.spawn(runtimeCommand, [...runtimeArgs, "run", "--", "node", "-e", parentCode], {
            cwd: replica,
            env,
            name: "xterm",
            cols: 80,
            rows: 24,
          })
        : undefined;
    const running = terminal
      ? (() => {
          let stdout = "";
          let markReady: (() => void) | undefined;
          const ready = new Promise<void>((resolve) => {
            markReady = resolve;
          });
          terminal.onData((data) => {
            stdout += data;
            if (stdout.includes("TREE_READY")) markReady?.();
          });
          return {
            ready: () => ready,
            result: new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
              terminal.onExit((event) => resolve({ code: event.exitCode, stdout, stderr: "" })),
            ),
          };
        })()
      : launch(["--", "node", "-e", parentCode], env);
    await running.ready("TREE_READY");
    const socket = NodeNet.connect(childPort, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    if (terminal) terminal.write("\x03");
    else if ("child" in running && mode === "interrupt") running.child.kill("SIGINT");
    else if ("child" in running && mode === "terminate") running.child.kill("SIGTERM");
    else {
      blocked = true;
      for (const pair of pairs) pair.destroy();
    }
    const result = await running.result;
    report(mode, result);
    NodeAssert.equal(result.code, mode === "cut" ? 255 : mode === "terminate" ? 143 : 130);
    await closed;
    if (mode === "cut") {
      const offline = await run("primary_offline", [
        "--",
        "node",
        "-e",
        "console.log('must not run')",
      ]);
      NodeAssert.equal(offline.code, 255);
      NodeAssert.match(offline.stderr, /cloudbox/);
      blocked = false;
      const monitor = NodeChildProcess.spawn("mutagen", ["sync", "monitor", session], {
        env: daemonEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      await new Promise<void>((resolve, reject) => {
        let text = "";
        monitor.stdout.on("data", (chunk) => {
          text += chunk;
          if (/watching for changes/i.test(text)) {
            monitor.kill("SIGTERM");
            resolve();
          }
        });
        monitor.stderr.on("data", (chunk) => (text += chunk));
        monitor.once("error", reject);
        monitor.once("close", (code) => {
          if (code !== null && code !== 0) reject(Error(`Mutagen did not resume: ${text}`));
        });
      });
      await mutagen("sync", "flush", session);
    }
  }
  await mutagen("sync", "terminate", session);
  await mutagen(
    "sync",
    "create",
    "--name",
    session,
    "--sync-mode",
    "two-way-safe",
    "--watch-mode",
    "no-watch",
    "--ignore-vcs",
    "--ignore",
    "/dist",
    "--ignore",
    "/.t3-conflicts",
    `t3-cloudbox:${primary}`,
    replica,
  );
  await mutagen("sync", "flush", session);
  const completed = await run("background_natural_start", [
    "--bg",
    "--",
    "node",
    "-e",
    "const fs=require('fs');fs.writeFileSync('bg-returned.txt','back');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/bg-output.txt','stays');fs.writeFileSync('dist/bg-line\\nbreak.txt','stays');for(let i=0;i<2048;i++)fs.writeFileSync('dist/bg-'+('Ю'.repeat(40))+'-'+i,'stays');console.log('BG_COMPLETE')",
  ]);
  NodeAssert.equal(completed.code, 0);
  const completedId = completed.stdout.trim();
  NodeAssert.match(completedId, /^[a-f0-9-]{36}$/);
  await awaitForwardingStop(primary, completedId);
  NodeAssert.equal(
    await NodeFSP.readFile(NodePath.join(replica, "bg-returned.txt"), "utf8"),
    "back",
  );
  const completedLogs = await launch(["--logs", completedId], env).result;
  report("background_natural_logs", {
    code: completedLogs.code,
    stdout: completedLogs.stdout,
    unicodeRetainedPaths: 2050,
    noteLines: completedLogs.stderr.trim().split("\n").length,
  });
  NodeAssert.equal(completedLogs.code, 0);
  NodeAssert.equal(completedLogs.stdout, "BG_COMPLETE\n");
  NodeAssert.match(completedLogs.stderr, /stayed on cloudbox/);
  const loggedPaths = new Set(
    completedLogs.stderr.trim().split(" stayed on cloudbox")[0]!.split(", "),
  );
  NodeAssert.equal(loggedPaths.size, 2050);
  for (let i = 0; i < 2048; i++) NodeAssert.ok(loggedPaths.has(`dist/bg-${"Ю".repeat(40)}-${i}`));
  NodeAssert.ok(loggedPaths.has("dist/bg-output.txt"));
  NodeAssert.ok(loggedPaths.has(JSON.stringify("dist/bg-line\nbreak.txt")));
  NodeAssert.equal(completedLogs.stderr.trim().split("\n").length, 1);
  const large = await launch(
    [
      "--",
      "node",
      "-e",
      "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});for(let i=0;i<16384;i++)fs.writeFileSync('dist/dependency-'+('x'.repeat(80))+'-'+i,'output')",
    ],
    env,
  ).result;
  report("large_ignored_result", {
    code: large.code,
    error: large.code === 0 ? undefined : large.stderr.slice(0, 2048),
  });
  NodeAssert.equal(large.code, 0);
  NodeAssert.equal(large.stderr.match(/dist\/dependency-/g)?.length, 16384);
  NodeAssert.equal(large.stderr.trim().split("\n").length, 1);
  NodeAssert.ok(large.stderr.length > 1048576);
  report("large_ignored_outputs", { code: large.code, paths: 16384, noteLines: 1 });
  const finalSessions = JSON.parse(await mutagen("sync", "list", "--template", "{{json .}}"));
  NodeAssert.equal(finalSessions.length, 1);
  NodeAssert.equal(
    await NodeFSP.readFile(NodePath.join(replica, ".t3-conflicts", "saved", "input.txt"), "utf8"),
    "replica edit",
  );
  report("converged", { sessions: finalSessions.length, losingVersion: "preserved" });
  const teardownCode =
    "require('net').createServer(()=>{}).listen(45555,'0.0.0.0',()=>console.log('TEARDOWN_READY'))";
  const teardown = launch(["--", "node", "-e", teardownCode], env);
  await teardown.ready("TEARDOWN_READY");
  const held = NodeNet.connect(childPort, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    held.once("connect", resolve);
    held.once("error", reject);
  });
  const closed = new Promise<void>((resolve) => held.once("close", () => resolve()));
  await managed.dispose();
  disposeRuntime = undefined;
  blocked = true;
  for (const pair of pairs) pair.destroy();
  const lost = await teardown.result;
  report("local_server_lost_during_cleanup", lost);
  NodeAssert.equal(lost.code, 255);
  NodeAssert.match(lost.stderr, /Cannot run on cloudbox:/);
  NodeAssert.match(lost.stderr, /post-run synchronization/);
  NodeAssert.equal(lost.stderr.trim().split("\n").length, 1);
  await closed;
  report("PASS", "real sshd + Mutagen; all local run scenarios");
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const closed = new Promise<void>((resolve) => daemon!.once("close", () => resolve()));
    daemon.kill("SIGCONT");
    daemon.kill("SIGTERM");
    await closed;
  }
  if (disposeRuntime) await disposeRuntime();
  for (const socket of pairs) socket.destroy();
  if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve()));
  try {
    await command("docker", ["rm", "-f", container]);
  } catch (error) {
    process.stderr.write(`Fixture container cleanup: ${String(error)}\n`);
  }
  await NodeFSP.rm(root, { recursive: true, force: true });
}
