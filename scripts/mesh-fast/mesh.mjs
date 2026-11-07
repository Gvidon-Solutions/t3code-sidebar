import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeURL from "node:url";
import { run, until, rpc, mcp } from "../mesh-e2e/client.mjs";

const repo = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const binary = NodePath.join(repo, "apps/server/src/bin.ts");
async function port() {
  const socket = NodeNet.createServer();
  socket.listen(0, "127.0.0.1");
  await NodeEvents.once(socket, "listening");
  const number = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return number;
}

export class MiniMesh {
  children = [];
  nodes = [];
  constructor(directory) {
    this.directory = directory;
  }

  async start(names = ["studio", "cloudbox", "laptop"]) {
    this.nodes = await Promise.all(names.map((name) => this.startNode(name)));
    for (const node of this.nodes)
      await rpc(node, "server.updateSettings", {
        patch: { meshEnabled: true, linkedEnvironmentsEnabled: true },
      });
    const hub = this.nodes[1];
    for (const node of this.nodes.filter((node) => node !== hub)) {
      const pair = JSON.parse(
        await run(
          process.execPath,
          [binary, "auth", "pairing", "create", "--base-dir", hub.base, "--ttl", "20m", "--json"],
          { env: hub.env },
        ),
      );
      await rpc(node, "peerLinks.link", {
        url: hub.origin,
        pairingCode: pair.credential,
        access: "full-access",
      });
    }
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
    return this.nodes;
  }

  launch(program, args, env, log) {
    const child = NodeChildProcess.spawn(program, args, {
      env,
      cwd: this.directory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const writes = [];
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => writes.push(NodeFSP.appendFile(log, data)));
    const closed = NodeEvents.once(child, "close").then(async () => {
      await Promise.all(writes);
    });
    this.children.push({ child, closed });
    return child;
  }

  async startNode(name) {
    const root = NodePath.join(this.directory, name);
    const home = NodePath.join(root, "home"),
      base = NodePath.join(root, "state");
    await NodeFSP.mkdir(home, { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: NodePath.join(home, ".config"),
      T3_MESH_AGENT_HOME: home,
      T3_MESH_SSH_HOME: home,
      T3_MESH_LEGACY_GLOBAL: NodePath.join(home, "absent"),
      T3_MESH_TIME_SCALE: "0.01",
      NODE_ENV: "test",
    };
    const sshPort = await port();
    const sshConfig = (
      await run(process.execPath, [
        NodePath.join(repo, "scripts/mesh-e2e/managed-sshd.mjs"),
        home,
        String(sshPort),
      ])
    ).trim();
    env.T3_MESH_SSHD_DIR = NodePath.dirname(sshConfig);
    this.launch(
      "/usr/sbin/sshd",
      ["-D", "-e", "-f", sshConfig],
      env,
      NodePath.join(root, "sshd.log"),
    );
    const backend = await port(),
      front = await port();
    const state = NodePath.join(root, "proxy.json");
    await NodeFSP.writeFile(state, JSON.stringify({ cut: false, denyPeer: name === "studio" }));
    this.launch(
      process.execPath,
      [
        NodePath.join(repo, "scripts/mesh-e2e/network-proxy.mjs"),
        String(front),
        String(backend),
        state,
      ],
      env,
      NodePath.join(root, "proxy.log"),
    );
    const child = this.launch(
      process.execPath,
      [
        binary,
        "serve",
        "--base-dir",
        base,
        "--host",
        "127.0.0.1",
        "--port",
        String(backend),
        "--no-browser",
      ],
      env,
      NodePath.join(root, "server.log"),
    );
    const origin = `http://127.0.0.1:${front}`;
    const descriptor = await until(
      `${name} ready`,
      async () => {
        if (child.exitCode !== null) throw Error(`${name} exited ${child.exitCode}`);
        return (await fetch(`${origin}/.well-known/t3/environment`)).json();
      },
      (value) => !!value.environmentId,
    );
    const token = (
      await run(
        process.execPath,
        [binary, "auth", "session", "issue", "--base-dir", base, "--ttl", "1h", "--token-only"],
        { env },
      )
    ).split("\n")[0];
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
      cli: (args) => run(process.execPath, [binary, ...args, "--base-dir", base], { env }),
    };
  }

  async fault(node, state) {
    await NodeFSP.writeFile(node.state, JSON.stringify(state));
  }

  async close() {
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
    for (const node of this.nodes) {
      const executable = NodePath.join(node.base, "bin", "mutagen");
      const data = NodePath.join(node.base, "mutagen");
      try {
        await NodeFSP.stat(NodePath.join(data, "daemon", "daemon.lock"));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      await run(executable, ["daemon", "stop"], {
        env: { ...node.env, MUTAGEN_DATA_DIRECTORY: data },
      });
    }
  }
}
export { rpc, until, mcp };
