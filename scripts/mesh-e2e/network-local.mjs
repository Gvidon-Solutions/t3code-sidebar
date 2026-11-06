import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeURL from "node:url";
const { once } = NodeEvents;
const repo = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const work = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "N1-local-network-"));
const children = [];
let container;
const run = (program, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(program, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${program} ${args[0]}: ${code}: ${stderr}: ${stdout}`)),
    );
    child.stdin.end();
  });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (description, read, accept) => {
  const end = Date.now() + 90_000;
  let result;
  do {
    try {
      result = await read();
      if (accept(result)) return result;
    } catch (error) {
      result = error.message;
    }
    await delay(250);
  } while (Date.now() < end);
  throw new Error(`${description}: ${JSON.stringify(result)}`);
};
const port = async () => {
  const server = NodeNet.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
};
const cli = (base, args, environment = process.env) =>
  run(
    process.execPath,
    [NodePath.join(repo, "apps/server/src/bin.ts"), ...args, "--base-dir", base],
    { env: environment },
  );
const start = async (name, publicHost = false) => {
  const root = NodePath.join(work, name),
    base = NodePath.join(root, "state"),
    home = NodePath.join(root, "home"),
    cwd = NodePath.join(root, `N1-${name}`);
  await NodeFSP.mkdir(home, { recursive: true });
  await NodeFSP.mkdir(cwd, { recursive: true });
  const backend = await port();
  const number = await port();
  const proxyState = NodePath.join(root, "proxy.json");
  await NodeFSP.writeFile(proxyState, JSON.stringify({ denyMcp: false, cut: false }));
  const environment = { ...process.env, HOME: home };
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.join(repo, "apps/server/src/bin.ts"),
      "serve",
      "--base-dir",
      base,
      "--host",
      "127.0.0.1",
      "--port",
      String(backend),
      "--no-browser",
    ],
    { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  const proxy = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.join(repo, "scripts/mesh-e2e/network-proxy.mjs"),
      String(number),
      String(backend),
      proxyState,
      publicHost ? "0.0.0.0" : "127.0.0.1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(proxy);
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });
  const origin = `http://127.0.0.1:${number}`;
  await until(
    `${name} startup`,
    async () => {
      if (child.exitCode !== null) throw new Error(log);
      const response = await fetch(`${origin}/.well-known/t3/environment`);
      return response.json();
    },
    (value) => !!value.environmentId,
  );
  const token = (
    await cli(
      base,
      ["auth", "session", "issue", "--ttl", "1h", "--label", "N1-local", "--token-only"],
      environment,
    )
  )
    .trim()
    .split("\n")[0];
  return { name, base, home, origin, port: number, token, environment, proxyState, log: () => log };
};
const rpc = async (node, tag, payload = {}) => {
  const response = await fetch(`${node.origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${node.token}` },
  });
  if (!response.ok) throw new Error(`ticket ${response.status}`);
  const { ticket } = await response.json();
  const ws = new WebSocket(
    `${node.origin.replace("http:", "ws:")}/ws?wsTicket=${encodeURIComponent(ticket)}&orchestrationProtocol=2&clientSurface=cli`,
  );
  await once(ws, "open");
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC ${tag} timed out`)), 60_000);
      ws.onmessage = (event) => {
        for (const line of String(event.data).split("\n")) {
          if (!line) continue;
          const message = JSON.parse(line);
          if (message._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
          if (message.requestId !== "N1") continue;
          if (message._tag === "Exit") {
            clearTimeout(timer);
            if (message.exit._tag === "Success") resolve(message.exit.value);
            else reject(new Error(`RPC ${tag}: ${JSON.stringify(message.exit.cause)}`));
          }
        }
      };
      ws.send(JSON.stringify({ _tag: "Request", id: "N1", tag, payload, headers: [] }));
    });
  } finally {
    ws.close();
  }
};
try {
  const cloudbox = await start("cloudbox", true);
  const laptop = await start("laptop");
  const studioPort = await port();
  container = `N1-network-studio-${process.pid}`;
  const wrapper = `node -e 'for(const name of ["N1-front-state","N1-network-state"])if(!require("node:fs").existsSync("/tmp/"+name+".json"))require("node:fs").writeFileSync("/tmp/"+name+".json",JSON.stringify({denyMcp:false,cut:false}))'; node /tmp/N1-network-proxy.mjs 3791 3792 /tmp/N1-front-state.json 0.0.0.0 & node /tmp/N1-network-proxy.mjs ${cloudbox.port} ${cloudbox.port} /tmp/N1-network-state.json 127.0.0.1 host.docker.internal & if [ -f /tmp/N1-sshd_config ]; then /usr/sbin/sshd -D -e -f /tmp/N1-sshd_config & fi; echo $$ > /tmp/N1-server-spawn.pid; exec node /opt/t3/dist/bin.mjs serve --base-dir /home/t3/.t3 --host 127.0.0.1 --port 3792 --no-browser`;
  await run("docker", [
    "create",
    "--name",
    container,
    "--restart",
    "on-failure",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-p",
    `127.0.0.1:${studioPort}:3791`,
    process.env.N1_IMAGE ?? "t3-mesh-e2e:n1",
    "sh",
    "-c",
    wrapper,
  ]);
  await run("docker", [
    "cp",
    NodePath.join(repo, "scripts/mesh-e2e/network-proxy.mjs"),
    `${container}:/tmp/N1-network-proxy.mjs`,
  ]);
  await run("docker", ["start", container]);
  const studio = { name: "studio", origin: `http://127.0.0.1:${studioPort}` };
  await until(
    "studio startup",
    async () => (await fetch(`${studio.origin}/.well-known/t3/environment`)).json(),
    (value) => !!value.environmentId,
  );
  const docker = (args) => run("docker", ["exec", container, ...args]);
  studio.token = (
    await docker([
      "node",
      "/opt/t3/dist/bin.mjs",
      "auth",
      "session",
      "issue",
      "--base-dir",
      "/home/t3/.t3",
      "--ttl",
      "1h",
      "--label",
      "N1-local",
      "--token-only",
    ])
  )
    .trim()
    .split("\n")[0];
  for (const node of [studio, cloudbox, laptop]) {
    node.id = (
      await (await fetch(`${node.origin}/.well-known/t3/environment`)).json()
    ).environmentId;
    await rpc(node, "server.updateSettings", {
      patch: { meshEnabled: true, linkedEnvironmentsEnabled: true },
    });
  }
  const pair = JSON.parse(
    await cli(
      cloudbox.base,
      ["auth", "pairing", "create", "--ttl", "20m", "--label", "N1-link", "--json"],
      cloudbox.environment,
    ),
  );
  await rpc(studio, "peerLinks.link", {
    url: cloudbox.origin,
    pairingCode: pair.credential,
    access: "full-access",
  });
  const second = JSON.parse(
    await cli(
      cloudbox.base,
      ["auth", "pairing", "create", "--ttl", "20m", "--label", "N1-link", "--json"],
      cloudbox.environment,
    ),
  );
  await rpc(laptop, "peerLinks.link", {
    url: cloudbox.origin,
    pairingCode: second.credential,
    access: "full-access",
  });
  const state = await until(
    "laptop relay",
    () => rpc(laptop, "meshLayout.status"),
    (value) =>
      value.connections?.some((row) => row.environmentId === studio.id && row.state === "relayed"),
  );
  const meshConfig = await rpc(cloudbox, "meshConfig.get");
  const applied = await rpc(cloudbox, "meshConfig.apply", {
    baseRevision: meshConfig.current.revision,
    doc: {
      ...meshConfig.current.doc,
      links: {
        ...meshConfig.current.doc.links,
        default: { ...meshConfig.current.doc.links?.default, files: "all" },
      },
    },
  });
  await until(
    "file permission convergence",
    () => Promise.all([studio, laptop].map((node) => rpc(node, "meshConfig.get"))),
    (values) => values.every((value) => value.current.revision === applied.revision),
  );
  console.log("PASS three production servers: incoming-only studio and laptop relay via cloudbox");
  for (const node of [cloudbox, laptop])
    await NodeFSP.writeFile(node.proxyState, JSON.stringify({ denyMcp: true, cut: false }));
  await docker([
    "node",
    "-e",
    "require('node:fs').writeFileSync('/tmp/N1-front-state.json',JSON.stringify({denyMcp:true,cut:false,denyPeer:true}))",
  ]);
  const nativeBaselines = new Map();
  for (const node of [studio, cloudbox, laptop]) {
    const blocked = await fetch(`${node.origin}/mcp`, { method: "POST", body: "{}" });
    if (blocked.status !== 503) throw new Error("Native HTTP MCP was not disabled");
    nativeBaselines.set(node.id, await (await fetch(`${node.origin}/__N1_network`)).json());
  }
  console.log("PASS native POST /mcp disabled on all three receiving servers");
  if ((await fetch(`${studio.origin}/peer`)).status !== 503)
    throw new Error("Studio still accepts inbound peer connections");
  console.log("PASS studio rejects inbound peer connections while outbound calls and relay work");
  await docker([
    "node",
    "-e",
    "require('node:fs').writeFileSync('/tmp/N1-network-file','N1 persistent relay')",
  ]);
  const file = await rpc(laptop, "files.read", {
    environmentId: studio.id,
    absolutePath: "/tmp/N1-network-file",
  });
  if (!file.contents.includes("N1 persistent relay")) throw new Error("relayed file mismatch");
  console.log("PASS production files.read over the one-hop connection path");
  const identity = NodePath.join(work, "identity");
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity]);
  await docker(["mkdir", "-p", "/home/t3/.ssh"]);
  await docker(["chmod", "700", "/home/t3/.ssh"]);
  await run("docker", ["cp", `${identity}.pub`, `${container}:/home/t3/.ssh/N1_authorized_keys`]);
  await run("docker", [
    "exec",
    "-u",
    "0",
    container,
    "chown",
    "t3:t3",
    "/home/t3/.ssh/N1_authorized_keys",
  ]);
  await docker(["chmod", "600", "/home/t3/.ssh/N1_authorized_keys"]);
  const config = NodePath.join(work, "sshd_config");
  await NodeFSP.writeFile(
    config,
    "Port 22\nListenAddress 127.0.0.1\nHostKey /etc/ssh/ssh_host_ed25519_key\nAuthorizedKeysFile /home/t3/.ssh/N1_authorized_keys\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nPidFile /tmp/N1-sshd.pid\nLogLevel VERBOSE\n",
  );
  await run("docker", ["cp", config, `${container}:/tmp/N1-sshd_config`]);
  await run("docker", [
    "exec",
    "-d",
    container,
    "/usr/sbin/sshd",
    "-D",
    "-e",
    "-f",
    "/tmp/N1-sshd_config",
  ]);
  const layout = await until(
    "reported host keys",
    () => rpc(cloudbox, "meshLayout.get"),
    (value) => !!value.config.machines[studio.id]?.reported?.sshd?.hostKeys.length,
  );
  const reported = layout.config.machines[studio.id].reported;
  const keys = NodePath.join(work, "host_keys.json");
  await NodeFSP.writeFile(keys, JSON.stringify(reported.sshd.hostKeys));
  const binary = NodePath.join(work, "t3");
  await NodeFSP.writeFile(
    binary,
    `#!/bin/sh\nexec '${process.execPath}' '${NodePath.join(repo, "apps/server/src/bin.ts")}' "$@"\n`,
    { mode: 0o700 },
  );
  await NodeFSP.writeFile(
    NodePath.join(work, "evidence.json"),
    JSON.stringify(
      { state, studio: studio.id, cloudbox: cloudbox.id, laptop: laptop.id, reported },
      null,
      2,
    ),
  );
  const ssh = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.join(repo, "scripts/mesh-e2e/network-ssh.mjs"),
      binary,
      laptop.base,
      studio.id,
      reported.user,
      keys,
    ],
    { env: { ...process.env, N1_SSH_IDENTITY: identity }, stdio: "inherit" },
  );
  const [code] = await once(ssh, "close");
  if (code !== 0) throw new Error(`SSH acceptance exit ${code}`);
  if (process.env.N1_FAULTS === "1") {
    await docker([
      "node",
      "-e",
      "require('node:fs').writeFileSync('/tmp/N1-network-state.json',JSON.stringify({denyMcp:true,cut:true}))",
    ]);
    const offline = await until(
      "relay offline",
      () => rpc(laptop, "meshLayout.status"),
      (value) =>
        value.connections?.some(
          (row) => row.environmentId === studio.id && row.state === "offline" && row.offlineSince,
        ),
    );
    await NodeFSP.writeFile(NodePath.join(work, "offline.json"), JSON.stringify(offline, null, 2));
    for (let elapsed = 0; elapsed < 180; elapsed += 30) {
      await delay(30_000);
      console.log(`N1 network cut: ${elapsed + 30}/180 seconds`);
    }
    await docker([
      "node",
      "-e",
      "require('node:fs').writeFileSync('/tmp/N1-network-state.json',JSON.stringify({denyMcp:true,cut:false}))",
    ]);
    await until(
      "relay reconnect",
      () => rpc(laptop, "meshLayout.status"),
      (value) =>
        value.connections?.some(
          (row) => row.environmentId === studio.id && row.state === "relayed",
        ),
    );
    await rpc(laptop, "files.read", {
      environmentId: studio.id,
      absolutePath: "/tmp/N1-network-file",
    });
    console.log("PASS automatic recovery after a three-minute network cut");
    const restarts = Number(
      (await run("docker", ["inspect", "-f", "{{.RestartCount}}", container])).trim(),
    );
    const pid = (await docker(["cat", "/tmp/N1-server-spawn.pid"])).trim();
    if (!/^\d+$/.test(pid) || Number(pid) <= 1) throw new Error("Invalid captured server PID");
    await docker(["kill", "-9", pid]);
    await until(
      "automatic container restart",
      async () =>
        Number((await run("docker", ["inspect", "-f", "{{.RestartCount}}", container])).trim()),
      (count) => count > restarts,
    );
    await until(
      "relay after SIGKILL",
      () => rpc(laptop, "meshLayout.status"),
      (value) =>
        value.connections?.some(
          (row) => row.environmentId === studio.id && row.state === "relayed",
        ),
    );
    await rpc(laptop, "files.read", {
      environmentId: studio.id,
      absolutePath: "/tmp/N1-network-file",
    });
    console.log("PASS SIGKILL of the captured server PID: automatic restart and relay recovery");
  }
  for (const node of [studio, cloudbox, laptop]) {
    const counters = await (await fetch(`${node.origin}/__N1_network`)).json();
    const baseline =
      node === studio && process.env.N1_FAULTS === "1"
        ? { mcp: 0, refusedMcp: 0 }
        : nativeBaselines.get(node.id);
    if (
      counters.mcp !== baseline.mcp ||
      counters.refusedMcp !== baseline.refusedMcp ||
      !counters.state.denyMcp
    )
      throw new Error(`Unexpected native MCP fallback: ${JSON.stringify(counters)}`);
  }
  console.log("PASS no native HTTP MCP requests during connected calls, pipes or recovery");
  console.log(`N1 LOCAL NETWORK ACCEPTANCE PASSED: ${work}`);
} finally {
  for (const child of children) child.kill("SIGTERM");
  if (container) await run("docker", ["rm", "-f", container]);
  for (const child of children) if (child.exitCode === null) await once(child, "close");
  console.log(`Evidence directory: ${work}`);
}
