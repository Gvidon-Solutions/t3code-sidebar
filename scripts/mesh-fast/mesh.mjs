import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import { run, until, rpc, mcp } from "./client.mjs";
import { waitForDaemonShutdown } from "./daemons.mjs";
import { ownership, labelArgs } from "./lifecycle.mjs";
import { containerBoot } from "./boot.mjs";
import { harnessRoot as repo, productRoot } from "./paths.mjs";

const binary = NodePath.join(productRoot, "apps/server/src/bin.ts");
let bootSlots = Math.max(2, Math.min(8, Math.floor(NodeOS.availableParallelism() / 2)));
const bootQueue = [];
async function boot(work) {
  if (bootSlots === 0) await new Promise((resolve) => bootQueue.push(resolve));
  else bootSlots--;
  try {
    return await work();
  } finally {
    const next = bootQueue.shift();
    if (next) next();
    else bootSlots++;
  }
}
const inactiveProviders = Object.fromEntries(
  ["codex", "claudeAgent"].map((driver) => [driver, { driver, enabled: false }]),
);
const allocatedPorts = new Set();
async function publish(file, value) {
  const temporary = file + "." + NodeCrypto.randomUUID() + ".tmp";
  await NodeFSP.writeFile(temporary, JSON.stringify(value));
  await NodeFSP.rename(temporary, file);
}
async function port() {
  const socket = NodeNet.createServer();
  socket.listen(0, "127.0.0.1");
  await NodeEvents.once(socket, "listening");
  const number = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  if (allocatedPorts.has(number)) return port();
  allocatedPorts.add(number);
  return number;
}

export class MiniMesh {
  static active = new Set();
  children = [];
  containers = [];
  beforeClose = [];
  nodes = [];
  constructor(directory) {
    MiniMesh.active.add(this);
    this.directory = directory;
    this.containerMode = true;
    this.warmAgents = true;
  }

  async start(names = ["studio", "cloudbox", "laptop"]) {
    this.owner = await ownership();
    this.routes = new Map();
    if (this.browser)
      await NodeFSP.mkdir(NodePath.join(this.directory, "artifacts"), { recursive: true });
    for (const value of this.extraRoutes ?? []) allocatedPorts.add(value);
    this.network =
      "mesh-fast-" +
      process.pid +
      "-" +
      NodePath.basename(this.directory).replaceAll(/[^a-z0-9-]/gi, "-");
    let allocated = false;
    for (let attempt = 0; attempt < 64; attempt++) {
      const subnet = `10.240.${NodeCrypto.randomInt(256)}.${NodeCrypto.randomInt(16) * 16}/28`;
      const address = subnet.split("/")[0].split(".");
      address[3] = String(Number(address[3]) + 1);
      const gateway = address.join(".");
      try {
        await run("docker", [
          "network",
          "create",
          ...labelArgs(this.owner),
          "--subnet",
          subnet,
          "--gateway",
          gateway,
          this.network,
        ]);
        this.gateway = gateway;
        this.networkCreated = true;
        allocated = true;
        break;
      } catch (error) {
        if (!/Pool overlaps|already in use/.test(error.message)) throw error;
      }
    }
    if (!allocated) throw Error("Could not allocate a private fixture subnet");

    for (const value of this.extraRoutes ?? [])
      this.launch(
        process.execPath,
        [
          new URL("forward.mjs", import.meta.url).pathname,
          String(value),
          "127.0.0.1",
          String(value),
          this.gateway,
        ],
        process.env,
        NodePath.join(this.directory, "gateway.log"),
      );
    this.firstName = names[0];
    this.nodeCount = names.length;
    for (const name of names) this.routes.set(name, await port());
    const started = await Promise.allSettled(names.map((name) => boot(() => this.startNode(name))));
    this.nodes = started.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    for (const result of started) if (result.status === "rejected") throw result.reason;
    for (const node of this.nodes)
      await rpc(node, "server.updateSettings", {
        patch: { meshEnabled: true, linkedEnvironmentsEnabled: true },
      });
    await Promise.all(
      this.nodes
        .filter(
          (node) => this.preserveIdentity !== true && !this.preserveIdentity?.includes(node.name),
        )
        .map(async (node) => {
          const current = await until(
            "initial private machine binding",
            () => rpc(node, "meshConfig.get"),
            (value) => Object.values(value.bindings).includes(node.id),
          );
          const old = Object.keys(current.bindings).find(
            (key) => current.bindings[key] === node.id,
          );
          await rpc(node, "meshConfig.apply", {
            baseRevision: current.current.revision,
            doc: {
              ...current.current.doc,
              machines: {
                [old]: {
                  ...current.current.doc.machines[old],
                  title: node.name,
                  label: node.name.slice(0, 2).toUpperCase(),
                },
              },
            },
          });
          const titled = await until(
            "private display title applied",
            () => rpc(node, "meshConfig.get"),
            (value) => value.current.doc.machines[old]?.title === node.name,
          );
          await rpc(node, "meshConfig.apply", {
            baseRevision: titled.current.revision,
            doc: {
              ...titled.current.doc,
              machines: { [node.name]: titled.current.doc.machines[old] },
            },
          });
          await until(
            "private named claim reconciled",
            () => rpc(node, "meshLayout.get"),
            (value) =>
              value.document["mesh.machineClaim/" + node.id]?.v?.name === node.name &&
              value.document["mesh.machineClaim/" + node.id]?.v?.machine?.title === node.name,
          );
        }),
    );
    const hub = this.nodes[1] ?? this.nodes[0];
    const leaves = this.nodes.filter((node) => node !== hub);
    if (this.reverseJoins) leaves.reverse();
    const join = async (node) => {
      const pair = JSON.parse(
        await hub.cli(["auth", "pairing", "create", "--ttl", "20m", "--json"]),
      );
      await rpc(node, "peerLinks.link", {
        url: hub.origin,
        pairingCode: pair.credential,
        access: "full-access",
      });
    };
    if (this.concurrentJoins) await Promise.all(leaves.map(join));
    else for (const node of leaves) await join(node);
    await until(
      "initial config convergence",
      () => Promise.all(this.nodes.map((node) => rpc(node, "meshConfig.get"))),
      (values) =>
        values.every(
          (value) =>
            value.current.revision === values[0].current.revision &&
            Object.keys(value.bindings).length === names.length,
        ),
    );
    await until(
      "managed SSH routes ready",
      () => Promise.all(this.nodes.map((node) => rpc(node, "meshConfig.status"))),
      (values) =>
        values.every((value, index) => {
          const row = value.servers.find((row) => row.environmentId === this.nodes[index].id);
          const routes = row?.actions.filter((action) => action.id.startsWith("ssh/route/"));
          return (
            routes?.length === names.length - 1 && routes.every((action) => action.state === "done")
          );
        }),
    );
    return this.nodes;
  }

  launch(program, args, env, log) {
    if (this.stopping) throw Error("Fixture is closing");
    const child = NodeChildProcess.spawn(program, args, {
      env,
      cwd: this.directory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const writes = [
      NodeFSP.appendFile(
        NodePath.join(this.directory, "children.jsonl"),
        JSON.stringify({ pid: child.pid, program, args }) + "\n",
      ),
    ];
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => writes.push(NodeFSP.appendFile(log, data)));
    const closed = NodeEvents.once(child, "close").then(async () => {
      await Promise.all(writes);
    });
    this.children.push({ child, closed, program });
    return child;
  }

  launchContainer(args, env, log) {
    const index = args.indexOf("--name");
    if (index < 0 || !args[index + 1]) throw Error("Fixture containers require an owned name");
    const child = this.launch(
      "docker",
      [args[0], ...labelArgs(this.owner), "--restart=no", ...args.slice(1)],
      env,
      log,
    );
    const spawned = { name: args[index + 1], child };
    this.containers.push(spawned);
    this.onContainerSpawn?.(spawned);
    return child;
  }

  async startNode(name) {
    if (this.stopping) throw Error("Fixture is closing");
    const inContainer =
      this.containerMode && (this.containerNames ?? [this.firstName]).includes(name);
    const bundled = process.env.MESH_FAST_REALISTIC !== "1" && !this.launcher;
    const nodeBinary =
      this.previousEntry && (this.previousAll || name === "laptop")
        ? this.previousEntry
        : this.skewable && name === this.firstName
          ? binary
          : NodePath.join(process.env.MESH_FAST_RUNTIMES, "0.1.6/bin.mjs");
    const root = NodePath.join(this.directory, name);
    const home = NodePath.join(root, "home"),
      base = NodePath.join(root, "state");
    await NodeFSP.mkdir(home, { recursive: true });
    const env = {
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      ...this.environment,
      HOME: home,
      XDG_CONFIG_HOME: NodePath.join(home, ".config"),
      XDG_DATA_HOME: NodePath.join(home, ".local/share"),
      XDG_CACHE_HOME: NodePath.join(home, ".cache"),
      CODEX_HOME: NodePath.join(home, ".codex"),
      SSH_AUTH_SOCK: "",
      GIT_CONFIG_GLOBAL: NodePath.join(home, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      T3_MESH_AGENT_HOME: home,
      T3_MESH_SSH_HOME: home,
      T3_MESH_LEGACY_GLOBAL: NodePath.join(home, "absent"),
      T3_MESH_TIME_SCALE:
        process.env.MESH_FAST_REALISTIC === "1"
          ? "1"
          : NodeOS.availableParallelism() < 8
            ? "0.2"
            : this.launcher || this.previousEntry
              ? "0.075"
              : "0.04",
      NODE_ENV: "test",
      GOMAXPROCS: "2",
      NODE_COMPILE_CACHE: NodePath.join(process.env.MESH_FAST_RUNTIMES, "compile-cache"),
    };
    if (process.env.MESH_FAST_MUTAGEN_CACHE && !this.coldInstall) {
      await NodeFSP.mkdir(NodePath.join(base, "bin"), { recursive: true });
      const sameDevice =
        (await NodeFSP.stat(home)).dev ===
        (await NodeFSP.stat(process.env.MESH_FAST_MUTAGEN_CACHE)).dev;
      for (const file of ["mutagen", "mutagen-agents.tar.gz"])
        await (sameDevice ? NodeFSP.link : NodeFSP.copyFile)(
          NodePath.join(process.env.MESH_FAST_MUTAGEN_CACHE, file),
          NodePath.join(base, "bin", file),
        );
      await NodeFSP.chmod(NodePath.join(base, "bin/mutagen"), 0o755);
    }
    if (this.warmAgents && !this.coldInstall) {
      const agentHome = NodePath.join(home, ".mutagen/agents/0.18.1");
      await NodeFSP.mkdir(agentHome, { recursive: true });
      const sameDevice =
        (await NodeFSP.stat(home)).dev ===
        (await NodeFSP.stat(process.env.MESH_FAST_MUTAGEN_CACHE)).dev;
      await (sameDevice ? NodeFSP.link : NodeFSP.copyFile)(
        NodePath.join(process.env.MESH_FAST_MUTAGEN_CACHE, "mutagen-agent-linux-amd64"),
        NodePath.join(agentHome, "mutagen-agent"),
      );
      await NodeFSP.chmod(NodePath.join(agentHome, "mutagen-agent"), 0o700);
    }
    if (!this.legacySeed) {
      await NodeFSP.mkdir(NodePath.join(base, "userdata"), { recursive: true });
      await publish(NodePath.join(base, "userdata/settings.json"), {
        providerInstances: inactiveProviders,
        ...(this.legacyIgnores ? { replicaIgnores: this.legacyIgnores } : {}),
      });
    }
    if (this.legacySeed) {
      await NodeFSP.mkdir(NodePath.join(base, "userdata"), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(base, "userdata/settings.json"),
        JSON.stringify({
          providerInstances: inactiveProviders,
          ...(this.legacyIgnores ? { replicaIgnores: this.legacyIgnores } : {}),
          sidebarWorkspaces: {
            workspaces: [
              { id: "main-" + name, name: "main" },
              { id: "notes-" + name, name: "notes-" + name },
            ],
            projectOrder: ["title:seed-" + name],
            placements: { ["title:seed-" + name]: ["main-" + name] },
          },
        }),
      );
    }
    const fakeBin = NodePath.join(home, "tool-bin");
    await NodeFSP.mkdir(fakeBin);
    await NodeFSP.writeFile(
      NodePath.join(fakeBin, "pnpm"),
      `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);if(JSON.stringify(args)!==JSON.stringify(['install','--frozen-lockfile']))throw Error('Unexpected install arguments');const r=require('node:child_process').spawnSync(${JSON.stringify(NodePath.join(process.env.MESH_FAST_MUTAGEN_CACHE, "pnpm-12.14.0/pnpm"))},args,{stdio:'inherit',env:{...process.env,npm_config_offline:'true',CI:'true'}});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status??1);fs.mkdirSync('.t3',{recursive:true});const n='.t3/install-count';fs.writeFileSync(n,String((fs.existsSync(n)?Number(fs.readFileSync(n)):0)+1));fs.copyFileSync('pnpm-lock.yaml','.t3/installed-lock');
`,
      { mode: 0o700 },
    );
    env.PATH = [
      fakeBin,
      NodePath.dirname(process.execPath),
      ...(inContainer ? ["/usr/local/bin"] : []),
      "/usr/sbin",
      "/usr/bin",
      "/bin",
    ].join(NodePath.delimiter);
    let mutagenDaemon;
    if (this.captureMutagen === name) {
      mutagenDaemon = this.launch(
        NodePath.join(base, "bin/mutagen"),
        ["daemon", "run"],
        {
          ...env,
          MUTAGEN_DATA_DIRECTORY: NodePath.join(base, "mutagen"),
          MUTAGEN_SSH_PATH: NodePath.join(base, "mesh/ssh/bin"),
        },
        NodePath.join(root, "captured-daemon.log"),
      );
      const ready = await until(
        "controlled daemon startup",
        async () => {
          if (mutagenDaemon.exitCode !== null || mutagenDaemon.signalCode !== null)
            return { exited: true };
          return new Promise((resolve, reject) => {
            const socket = NodeNet.connect(NodePath.join(base, "mutagen/daemon/daemon.sock"));
            socket.once("connect", () => {
              socket.end();
              resolve({ ready: true });
            });
            socket.once("error", reject);
          });
        },
        (value) => value.exited || value.ready,
      );
      if (ready.exited) throw Error("Controlled Mutagen daemon exited before startup");
    }
    if (inContainer) env.SHELL = "/bin/bash";
    if (this.skewable) {
      env.MESH_FAST_CLOCK_FILE = NodePath.join(home, "clock-offset");
      await NodeFSP.writeFile(env.MESH_FAST_CLOCK_FILE, "0");
    }
    const sshPort = await port();
    const sshConfig = (
      await run(process.execPath, [
        NodePath.join(repo, "scripts/mesh-e2e/managed-sshd.mjs"),
        home,
        String(sshPort),
      ])
    ).trim();
    if (inContainer)
      await NodeFSP.writeFile(
        sshConfig,
        (await NodeFSP.readFile(sshConfig, "utf8")).replace(/^AllowUsers .*$/m, "AllowUsers node"),
      );
    const sshCommand = NodePath.join(home, "sshd/command.sh");
    await NodeFSP.writeFile(
      sshCommand,
      `#!/bin/sh
set -eu
cd "$HOME"
if [ "\${SSH_ORIGINAL_COMMAND:-}" = internal-sftp ]; then
  exec /usr/lib/openssh/sftp-server
fi
exec /bin/bash --noprofile --norc -c "\${SSH_ORIGINAL_COMMAND:-exec /bin/bash --noprofile --norc}"
`,
      { mode: 0o700 },
    );
    await NodeFSP.appendFile(
      sshConfig,
      `SetEnv ${JSON.stringify("HOME=" + home)} ${JSON.stringify("PATH=" + env.PATH)} ${JSON.stringify("NODE_COMPILE_CACHE=" + env.NODE_COMPILE_CACHE)} GOMAXPROCS=2\nForceCommand ${JSON.stringify(sshCommand)}\n`,
    );
    env.T3_MESH_SSHD_DIR = NodePath.dirname(sshConfig);
    if (!inContainer)
      this.launch(
        "/usr/sbin/sshd",
        ["-D", "-e", "-f", sshConfig],
        env,
        NodePath.join(root, "sshd.log"),
      );
    const backend = await port(),
      front = this.routes.get(name);
    this.launch(
      process.execPath,
      [
        new URL("forward.mjs", import.meta.url).pathname,
        String(front),
        "127.0.0.1",
        String(front),
        this.gateway,
      ],
      env,
      NodePath.join(root, "gateway.log"),
    );
    const state = NodePath.join(root, "proxy.json");
    await NodeFSP.writeFile(
      state,
      JSON.stringify({
        cut: false,
        denyPeer: name === this.firstName,
        inspectPipe: this.messageProxy && name === "cloudbox",
      }),
    );
    if (!inContainer)
      this.launch(
        process.execPath,
        [
          NodePath.join(repo, "scripts/mesh-fast/proxy.mjs"),
          String(front),
          String(backend),
          state,
          "127.0.0.1",
        ],
        env,
        NodePath.join(root, "proxy.log"),
      );
    const useSource =
      bundled ||
      (this.skewable && name === this.firstName) ||
      (this.previousEntry && (this.previousAll || name === "laptop"));
    const native = NodePath.join(root, "runtime/t3");
    if (!this.previousEntry || name !== "laptop")
      await run("cp", [
        "-al",
        NodePath.join(process.env.MESH_FAST_RUNTIMES, "0.1.6"),
        NodePath.join(root, "runtime"),
      ]);
    let serverCommand = useSource ? process.execPath : native;
    let serverArgs = [
      ...(useSource ? [nodeBinary] : []),
      "serve",
      "--base-dir",
      base,
      "--host",
      "127.0.0.1",
      "--port",
      String(backend),
      "--no-browser",
    ];
    if (this.launcher) {
      const installed = NodePath.join(base, "runtime/versions/0.1.5");
      await NodeFSP.mkdir(NodePath.dirname(installed), { recursive: true });
      await NodeFSP.cp(NodePath.join(process.env.MESH_FAST_RUNTIMES, "0.1.5"), installed, {
        recursive: true,
      });
      await NodeFSP.writeFile(NodePath.join(installed, ".install-complete"), "0.1.5\n");
      await NodeFSP.writeFile(
        NodePath.join(base, "runtime/service-state.json"),
        JSON.stringify({ protocol: 3, activeVersion: "0.1.5" }),
      );
      Object.assign(env, {
        T3CODE_HOME: base,
        T3CODE_PORT: String(backend),
        T3CODE_HOST: "127.0.0.1",
        T3CODE_NO_BROWSER: "true",
        T3_MESH_TEST_MODE: "1",
      });
      if (name === "laptop") env.T3_MESH_TEST_FAIL_HEALTH_VERSION = "0.1.6";
      serverArgs = [NodePath.join(installed, "t3"), "__service-launcher"];
    }
    if (this.skewable && name === this.firstName)
      serverArgs.unshift("--import", NodePath.join(repo, "scripts/mesh-fast/clock.mjs"));
    if (this.launcher) {
      serverCommand = serverArgs.shift();
    }
    const spec = NodePath.join(root, "server-spec.json"),
      receipt = NodePath.join(root, "server-process.json");
    await NodeFSP.writeFile(
      spec,
      JSON.stringify({
        command: serverCommand,
        args: serverArgs,
      }),
    );
    let container;
    let child;
    let descriptor;
    const origin = `http://127.0.0.1:${front}`;
    const ready = async () => {
      if (this.stopping) throw Error("Fixture is closing");
      if (inContainer) {
        container = this.network + "-" + name;
        await until(
          "local node routes allocated",
          async () => this.routes.size,
          (value) => value === this.nodeCount,
        );
        const containerConfig = NodePath.join(root, "container.json");
        await NodeFSP.writeFile(
          spec,
          JSON.stringify({
            command: useSource ? "/usr/local/bin/node" : serverCommand,
            args: serverArgs,
          }),
        );
        await NodeFSP.writeFile(
          containerConfig,
          JSON.stringify({
            routes: [
              ...[...this.routes]
                .filter(([peer]) => peer !== name)
                .map(([, port]) => ({ port, target: port })),
              ...(this.extraRoutes ?? []).map((port) => ({ port, target: port })),
            ],
            children: [
              ["/usr/sbin/sshd", "-D", "-e", "-f", sshConfig],
              [
                "/usr/local/bin/node",
                NodePath.join(repo, "scripts/mesh-fast/proxy.mjs"),
                String(front),
                String(backend),
                state,
                "0.0.0.0",
              ],
              [
                "/usr/local/bin/node",
                NodePath.join(repo, "scripts/mesh-fast/supervisor.mjs"),
                spec,
                receipt,
              ],
            ],
          }),
        );
        child = this.launchContainer(
          [
            "run",
            "--init",
            "--name",
            container,
            "--network",
            this.network,
            "--hostname",
            this.hostnames?.[name] ?? name,
            "--add-host",
            "host.docker.internal:" + this.gateway,
            "-p",
            `127.0.0.1:${front}:${front}`,
            "-v",
            repo + ":" + repo + ":ro",
            ...(productRoot === repo ? [] : ["-v", productRoot + ":" + productRoot + ":ro"]),
            "-v",
            root + ":" + root,
            "-v",
            process.env.MESH_FAST_RUNTIMES + ":" + process.env.MESH_FAST_RUNTIMES + ":ro",
            "-v",
            NodePath.join(process.env.MESH_FAST_MUTAGEN_CACHE, "pnpm-12.14.0") +
              ":" +
              NodePath.join(process.env.MESH_FAST_MUTAGEN_CACHE, "pnpm-12.14.0") +
              ":ro",
            ...(this.browser
              ? [
                  "-v",
                  NodePath.join(this.directory, "artifacts") +
                    ":" +
                    NodePath.join(this.directory, "artifacts"),
                  "-v",
                  process.env.PLAYWRIGHT_BROWSERS_PATH +
                    ":" +
                    process.env.PLAYWRIGHT_BROWSERS_PATH +
                    ":ro",
                ]
              : []),
            ...Object.entries(env).flatMap(([key, value]) => ["-e", key + "=" + value]),
            "mesh-fast-node:26",
            "sh",
            "-ec",
            `usermod -u ${process.getuid()} -d '${home}' node; exec runuser -u node -- /usr/local/bin/node '${NodePath.join(repo, "scripts/mesh-fast/container-node.mjs")}' '${containerConfig}'`,
          ],
          process.env,
          NodePath.join(root, "server.log"),
        );
      } else
        child = this.launch(
          process.execPath,
          [NodePath.join(repo, "scripts/mesh-fast/supervisor.mjs"), spec, receipt],
          env,
          NodePath.join(root, "server.log"),
        );
      descriptor = await until(
        `${name} ready`,
        async () => {
          if (child.exitCode !== null || child.signalCode !== null)
            return { startupExit: child.exitCode ?? child.signalCode };
          return (await fetch(`${origin}/.well-known/t3/environment`)).json();
        },
        (value) => value.startupExit !== undefined || !!value.environmentId,
      );
      if (descriptor.startupExit !== undefined)
        throw Error(
          `${name} exited ${descriptor.startupExit}: ${await NodeFSP.readFile(NodePath.join(root, "server.log"), "utf8")}`,
        );
    };
    if (inContainer) await containerBoot(ready);
    else await ready();
    const token = (
      await run(
        useSource ? process.execPath : native,
        [
          ...(useSource ? [nodeBinary] : []),
          "auth",
          "session",
          "issue",
          "--base-dir",
          base,
          "--ttl",
          "12h",
          "--token-only",
        ],
        { env },
      )
    ).split("\n")[0];
    if (container && useSource) serverCommand = "/usr/local/bin/node";
    return {
      name,
      root,
      home,
      base,
      env,
      origin,
      state,
      token,
      id: descriptor.environmentId,
      child,
      serverArgs,
      serverCommand,
      backend,
      front,
      sshPort,
      spec,
      receipt,
      container,
      inactiveProviders,
      mutagenDaemon,
      cli: (args) =>
        run(
          useSource ? process.execPath : native,
          [...(useSource ? [nodeBinary] : []), ...args, "--base-dir", base],
          { env },
        ),
    };
  }

  async fault(node, state) {
    await publish(node.state, {
      inspectPipe: this.messageProxy && node.name === "cloudbox",
      ...state,
    });
  }

  async signal(node, signal) {
    const processState = JSON.parse(await NodeFSP.readFile(node.receipt, "utf8"));
    if (!Number.isSafeInteger(processState.pid) || processState.pid <= 1)
      throw Error("Invalid captured server PID");
    if (node.container)
      await run("docker", [
        "exec",
        node.container,
        "kill",
        "-" + signal.slice(3),
        String(processState.pid),
      ]);
    else process.kill(processState.pid, signal);
    return processState;
  }
  async stop(node) {
    const spec = JSON.parse(await NodeFSP.readFile(node.spec, "utf8"));
    await publish(node.spec, { ...spec, paused: true });
    await this.signal(node, "SIGTERM");
    await until(
      "supervisor stopped",
      async () => JSON.parse(await NodeFSP.readFile(node.receipt, "utf8")),
      (value) => value.stopped,
    );
    delete node.mcpInitialized;
    delete node.mcpSession;
  }
  async resume(node) {
    await publish(node.spec, { command: node.serverCommand, args: node.serverArgs });
    await until(
      node.name + " resumed",
      async () => (await fetch(node.origin + "/.well-known/t3/environment")).json(),
      (value) => value.environmentId === node.id,
    );
  }
  async restart(node) {
    await publish(node.spec, { command: node.serverCommand, args: node.serverArgs });
    const before = await this.signal(node, "SIGKILL");
    await until(
      "automatic supervisor restart",
      async () => JSON.parse(await NodeFSP.readFile(node.receipt, "utf8")),
      (value) => value.generation > before.generation && value.pid !== before.pid,
    );
    delete node.mcpInitialized;
    delete node.mcpSession;
    await until(
      node.name + " recovered",
      async () => (await fetch(node.origin + "/.well-known/t3/environment")).json(),
      (value) => value.environmentId === node.id,
    );
  }

  close() {
    this.stopping = true;
    this.closing ??= this.shutdown().finally(() => MiniMesh.active.delete(this));
    return this.closing;
  }
  async shutdown() {
    const errors = [];
    const settle = async (tasks) => {
      for (const result of await Promise.allSettled(tasks))
        if (result.status === "rejected") errors.push(result.reason);
    };
    await settle(this.beforeClose.map((cleanup) => cleanup()));
    for (const { child, program } of this.children)
      if (program !== "docker" && child.exitCode === null) child.kill("SIGTERM");
    const created = [];
    await settle(
      this.containers.map(async ({ name, child }) => {
        const state = await until(
          "owned container creation settles",
          async () => {
            try {
              await run("docker", ["container", "inspect", name]);
              return { exists: true };
            } catch (error) {
              if (!/No such (object|container)/i.test(error.message)) throw error;
              return {
                exists: false,
                exited: child.exitCode !== null || child.signalCode !== null,
              };
            }
          },
          (value) => value.exists || value.exited,
        );
        if (!state.exists) return;
        created.push(name);
        await run("docker", [
          "stop",
          "--time",
          process.env.MESH_FAST_REALISTIC === "1" ? "1" : "0",
          name,
        ]);
      }),
    );
    for (const { child } of this.children) if (child.exitCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => {
      for (const { child } of this.children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 3000);
    try {
      await Promise.all(this.children.map(({ closed }) => closed));
    } finally {
      clearTimeout(timer);
    }
    await settle(created.map((name) => run("docker", ["rm", "-f", name])));
    if (this.networkCreated) {
      await until(
        "private container network released",
        async () => JSON.parse(await run("docker", ["network", "inspect", this.network]))[0],
        (value) => Object.keys(value.Containers ?? {}).length === 0,
      );
      await run("docker", ["network", "rm", this.network]);
    }
    await settle(
      this.nodes.map(async (node) => {
        const executable = NodePath.join(node.base, "bin", "mutagen");
        const data = NodePath.join(node.base, "mutagen");
        const active = await new Promise((resolve, reject) => {
          const socket = NodeNet.connect(NodePath.join(data, "daemon/daemon.sock"));
          socket.once("connect", () => {
            socket.end();
            resolve(true);
          });
          socket.once("error", (error) => {
            if (["ENOENT", "ECONNREFUSED"].includes(error.code)) resolve(false);
            else reject(error);
          });
          socket.setTimeout(1000, () => {
            socket.destroy();
            reject(Error("Private daemon shutdown probe timed out"));
          });
        });
        if (active)
          await run(executable, ["daemon", "stop"], {
            env: { ...node.env, MUTAGEN_DATA_DIRECTORY: data },
          });
        await waitForDaemonShutdown(data);
      }),
    );
    if (errors.length)
      throw new AggregateError(
        errors,
        "Private fixture cleanup failed:\n" +
          errors.map((error) => error.stack ?? String(error)).join("\n"),
      );
  }
}
export { rpc, until, mcp, port as allocatePort };
