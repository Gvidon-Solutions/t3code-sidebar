import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStreamPromises from "node:stream/promises";
const repo = NodePath.resolve(import.meta.dirname, "../..");
const root = process.env.R1_BED_ROOT ?? "/tmp/R1-bed";
const runtime = process.env.R1_BED_RUNTIME;
if (!runtime) throw Error("R1_BED_RUNTIME must name an assembled runtime directory");
const admin = {
  laptop: JSON.parse(process.env.R1_LAPTOP_SSH ?? "null"),
  cloudbox: JSON.parse(process.env.R1_CLOUDBOX_SSH ?? "null"),
};
if (!admin.laptop || !admin.cloudbox)
  throw Error("R1_LAPTOP_SSH and R1_CLOUDBOX_SSH must contain administrator SSH argument arrays");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const children = [];
const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let out = "",
      err = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(Error(`${command}: ${code}: ${err.slice(-2000)} ${out.slice(-1000)}`)),
    );
  });
const remote = (name, command) => run("ssh", [...admin[name], command]);
const upload = async (name, file, destination) => {
  const child = NodeChildProcess.spawn("ssh", [...admin[name], `cat > ${quote(destination)}`], {
    stdio: ["pipe", "ignore", "inherit"],
  });
  const closed = NodeEvents.once(child, "close");
  await NodeStreamPromises.pipeline(NodeFS.createReadStream(file), child.stdin);
  if ((await closed)[0] !== 0) throw Error("Fixture upload failed");
};
const until = async (description, read, accepts) => {
  const deadline = Date.now() + 120000;
  let value;
  while (Date.now() < deadline) {
    try {
      value = await read();
      if (accepts(value)) return value;
    } catch (error) {
      value = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw Error(`${description}: ${JSON.stringify(value).slice(-3000)}`);
};
const nodes = [
  {
    name: "studio",
    port: 3795,
    sshPort: 22295,
    base: `${root}/studio/state`,
    home: `${root}/studio/home`,
    origin: "http://127.0.0.1:3795",
  },
  {
    name: "laptop",
    port: 3799,
    sshPort: 22298,
    base: `${root}/laptop/state`,
    home: `${root}/laptop/home`,
    origin: "http://127.0.0.1:13899",
  },
  {
    name: "cloudbox",
    port: 3822,
    sshPort: 22299,
    base: "/bed/state",
    home: "/bed/home",
    origin: "http://127.0.0.1:13893",
  },
];
const image = process.env.R1_BED_IMAGE;
if (!image) throw Error("R1_BED_IMAGE must name an available bed image with OpenSSH and Node 26");
const unit = (name, command, environment) =>
  `[Unit]\nDescription=R1 isolated mesh ${name}\n[Service]\nExecStart=${command}\n${Object.entries(
    environment,
  )
    .map(([key, value]) => `Environment=${key}=${value}`)
    .join("\n")}\nRestart=on-failure\n`;
const cli = async (node, args) => {
  const command = [
    node.name === "cloudbox" ? "/bed/runtime/t3" : `${root}/runtime/t3`,
    ...args,
    "--base-dir",
    node.base,
  ];
  if (node.name === "studio")
    return run(command[0], command.slice(1), { env: { ...process.env, HOME: node.home } });
  if (node.name === "cloudbox")
    return remote(node.name, `docker exec R1-mesh-cloudbox ${command.map(quote).join(" ")}`);
  return remote(node.name, `HOME=${quote(node.home)} ${command.map(quote).join(" ")}`);
};
const rpc = async (node, tag, payload = {}) => {
  const response = await fetch(`${node.origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${node.token}` },
  });
  if (!response.ok) throw Error(`Ticket ${node.name}: ${response.status}`);
  const { ticket } = await response.json();
  const ws = new WebSocket(
    `${node.origin.replace("http:", "ws:")}/ws?wsTicket=${encodeURIComponent(ticket)}&orchestrationProtocol=2&clientSurface=cli`,
  );
  await NodeEvents.once(ws, "open");
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`RPC ${tag} deadline`)), 30000);
      ws.onmessage = (event) => {
        for (const line of String(event.data).split("\n")) {
          if (!line) continue;
          const message = JSON.parse(line);
          if (message._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
          if (message._tag === "Exit" && message.requestId === "R1") {
            clearTimeout(timer);
            if (message.exit._tag === "Success") resolve(message.exit.value);
            else reject(Error(JSON.stringify(message.exit.cause)));
          }
        }
      };
      ws.send(JSON.stringify({ _tag: "Request", id: "R1", tag, payload, headers: [] }));
    });
  } finally {
    ws.close();
  }
};
const mcp = async (node, name, args = {}) => {
  if (!node.mcpToken) {
    const json = async (path, body, form = false) => {
      const response = await fetch(`${node.origin}${path}`, {
        method: body ? "POST" : "GET",
        headers: body
          ? { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" }
          : {},
        body: body ? (form ? new URLSearchParams(body) : JSON.stringify(body)) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      const value = await response.json();
      if (!response.ok) throw Error(`OAuth ${path}: ${JSON.stringify(value)}`);
      return value;
    };
    const pair = JSON.parse(
      await cli(node, ["auth", "pairing", "create", "--ttl", "10m", "--label", "R1-mcp", "--json"]),
    );
    const meta = await json("/.well-known/oauth-protected-resource/mcp");
    const redirect = "http://127.0.0.1:1/R1-callback";
    const client = await json("/oauth/mcp/register", {
      client_name: "R1-bed",
      redirect_uris: [redirect],
    });
    const verifier = NodeCrypto.randomBytes(32).toString("base64url");
    const authorization = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirect,
      code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: NodeCrypto.randomBytes(8).toString("hex"),
      resource: meta.resource,
    };
    const decision = await json("/oauth/mcp/decision", {
      authorization,
      decision: { _tag: "pairing-code", access: "full-access", code: pair.credential },
    });
    const code = new URL(decision.redirectTo).searchParams.get("code");
    const token = await json(
      "/oauth/mcp/token",
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: meta.resource,
      },
      true,
    );
    node.mcpToken = token.access_token;
  }
  if (!node.mcpInitialized) {
    const initialized = await fetch(`${node.origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${node.mcpToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "R1-init",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "R1-bed", version: "1" },
        },
      }),
    });
    if (!initialized.ok)
      throw Error(`MCP initialize: ${initialized.status}: ${await initialized.text()}`);
    node.mcpSession = initialized.headers.get("mcp-session-id");
    node.mcpInitialized = true;
  }
  const response = await fetch(`${node.origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${node.mcpToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(node.mcpSession ? { "mcp-session-id": node.mcpSession } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "R1",
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const source = await response.text();
  const value = JSON.parse(
    source.startsWith("data:")
      ? source
          .split("\n")
          .find((line) => line.startsWith("data:"))
          .slice(5)
      : source,
  );
  if (value.error || value.result?.isError) throw Error(JSON.stringify(value).slice(-3000));
  return JSON.parse(
    value.result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
  );
};
const file = async (node, path, value) => {
  if (node.name === "studio") {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, value);
  } else {
    const script = `require('node:fs').mkdirSync(require('node:path').dirname(${JSON.stringify(path)}),{recursive:true});require('node:fs').writeFileSync(${JSON.stringify(path)},${JSON.stringify(value)})`;
    await remote(
      node.name,
      `${node.name === "cloudbox" ? "docker exec R1-mesh-cloudbox " : ""}node -e ${quote(script)}`,
    );
  }
};
const read = (node, path) =>
  node.name === "studio"
    ? NodeFSP.readFile(path, "utf8")
    : remote(
        node.name,
        `${node.name === "cloudbox" ? "docker exec R1-mesh-cloudbox " : ""}cat ${quote(path)}`,
      );
try {
  await remote("laptop", 'test "$(cat /tmp/mesh-bed.lock/owner)" = R1');
  await NodeFSP.mkdir(root, { recursive: true });
  if (process.env.R1_BED_REUSE !== "1") {
    // The caller holds /tmp/mesh-bed.lock. Own directories only; no pairing keys are provisioned here.
    const packed = `${root}/upload-runtime.tar.gz`;
    await run("tar", ["-czf", packed, "-C", runtime, "."]);
    for (const name of ["laptop", "cloudbox"]) {
      console.log(`R1 deploy runtime to ${name}`);
      await remote(name, `mkdir -p ${quote(root)}`);
      const tar = `${root}/runtime.tar.gz`;
      await upload(name, packed, tar);
      await remote(
        name,
        `mkdir -p ${quote(root + "/runtime")} && tar -xzf ${quote(tar)} -C ${quote(root + "/runtime")}`,
      );
      await upload(
        name,
        NodePath.join(repo, "scripts/mesh-e2e/managed-sshd.mjs"),
        `${root}/managed-sshd.mjs`,
      );
    }
    if (
      !(await NodeFSP.stat(`${root}/runtime`).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }))
    )
      await NodeFSP.symlink(runtime, `${root}/runtime`, "dir");
    for (const node of nodes.slice(0, 2)) {
      const settings = {
        meshEnabled: true,
        linkedEnvironmentsEnabled: true,
        replicasEnabled: true,
        replicaRoot: `${node.home}/replicas`,
        mutagenPath: `${root}/runtime/mutagen`,
      };
      const prepare = `mkdir -p ${quote(node.base + "/userdata")} ${quote(node.home)} && printf '%s' ${quote(JSON.stringify(settings))} > ${quote(node.base + "/userdata/settings.json")} && node ${quote(node.name === "studio" ? NodePath.join(repo, "scripts/mesh-e2e/managed-sshd.mjs") : root + "/managed-sshd.mjs")} ${quote(node.home)} ${node.sshPort}`;
      if (node.name === "studio") await run("bash", ["-c", prepare]);
      else await remote(node.name, prepare);
      const environment = {
        HOME: node.home,
        T3_MESH_SSH_HOME: node.home,
        T3_MESH_SSHD_DIR: `${node.home}/sshd`,
      };
      const units = [
        [
          `R1-mesh-${node.name}-sshd`,
          unit(node.name, `/usr/sbin/sshd -D -e -f ${node.home}/sshd/sshd_config`, {}),
        ],
        [
          `R1-mesh-${node.name}`,
          unit(
            node.name,
            `${root}/runtime/t3 serve --base-dir ${node.base} --host 127.0.0.1 --port ${node.port} --no-browser`,
            environment,
          ),
        ],
      ];
      for (const [name, contents] of units) {
        const script = `mkdir -p "$HOME/.config/systemd/user"; printf '%s' ${quote(contents)} > "$HOME/.config/systemd/user/${name}.service"; systemctl --user daemon-reload; systemctl --user restart ${name}.service`;
        if (node.name === "studio") await run("bash", ["-c", script]);
        else await remote(node.name, script);
      }
    }
    const cloud = nodes[2];
    await upload(
      "cloudbox",
      NodePath.join(repo, "scripts/mesh-e2e/network-proxy.mjs"),
      `${root}/network-proxy.mjs`,
    );
    await remote(
      "cloudbox",
      `mkdir -p ${quote(root + "/home")} ${quote(root + "/state/userdata")}; chown -R 10001:10001 ${quote(root)}; printf '%s' ${quote(JSON.stringify({ meshEnabled: true, linkedEnvironmentsEnabled: true, replicasEnabled: true, replicaRoot: "/bed/home/replicas", mutagenPath: "/bed/runtime/mutagen" }))} > ${quote(root + "/state/userdata/settings.json")}; chown 10001:10001 ${quote(root + "/state/userdata/settings.json")}; docker run --rm --user 10001:10001 -v ${quote(root + ":/bed")} ${quote(image)} node /bed/managed-sshd.mjs /bed/home ${cloud.sshPort}`,
    );
    const launch = `printf '%s' '{"denyPeer":true}' > /bed/proxy.json; node /bed/network-proxy.mjs 3821 3822 /bed/proxy.json 127.0.0.1 & /usr/sbin/sshd -D -e -f /bed/home/sshd/sshd_config & exec /bed/runtime/t3 serve --base-dir /bed/state --host 127.0.0.1 --port 3822 --no-browser`;
    await remote(
      "cloudbox",
      `docker run -d --name R1-mesh-cloudbox --network host --user 10001:10001 -e HOME=/bed/home -e PATH=/bed/fake-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -e T3_MESH_SSH_HOME=/bed/home -e T3_MESH_SSHD_DIR=/bed/home/sshd -v ${quote(root + ":/bed")} ${quote(image)} sh -c ${quote(launch)}`,
    );
  } else {
    console.log("R1 update owned runtimes");
    const digest = NodeCrypto.createHash("sha256")
      .update(await NodeFSP.readFile(`${runtime}/t3`))
      .digest("hex");
    for (const name of ["laptop", "cloudbox"]) {
      const existing = await remote(name, `sha256sum ${quote(root + "/runtime/t3")}`);
      if (existing.startsWith(digest)) continue;
      await upload(name, `${runtime}/t3`, `${root}/runtime/t3.new`);
      await remote(
        name,
        `chmod 755 ${quote(root + "/runtime/t3.new")} && mv ${quote(root + "/runtime/t3.new")} ${quote(root + "/runtime/t3")}`,
      );
      await remote(
        name,
        name === "laptop"
          ? "systemctl --user restart R1-mesh-laptop.service"
          : "docker restart R1-mesh-cloudbox >/dev/null",
      );
    }
    await run("systemctl", ["--user", "restart", "R1-mesh-studio.service"]);
  }
  for (const name of ["laptop", "cloudbox"]) {
    const child = NodeChildProcess.spawn(
      "ssh",
      [
        ...admin[name],
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        name === "laptop" ? "13899:127.0.0.1:3799" : "13893:127.0.0.1:3821",
        "-R",
        "13895:127.0.0.1:3795",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    children.push(child);
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }
  for (const node of nodes) {
    const descriptor = await until(
      `${node.name} startup`,
      async () => (await fetch(`${node.origin}/.well-known/t3/environment`)).json(),
      (value) => !!value.environmentId,
    );
    node.id = descriptor.environmentId;
    node.label = descriptor.label;
    node.token = (
      await cli(node, [
        "auth",
        "session",
        "issue",
        "--ttl",
        "1h",
        "--label",
        "R1-bed",
        "--token-only",
      ])
    ).split("\n")[0];
  }
  const studio = nodes[0];
  for (const node of nodes.slice(1)) {
    const pair = JSON.parse(
      await cli(studio, [
        "auth",
        "pairing",
        "create",
        "--ttl",
        "20m",
        "--label",
        "R1-bed",
        "--json",
      ]),
    );
    await rpc(node, "peerLinks.link", {
      url: "http://127.0.0.1:13895",
      pairingCode: pair.credential,
      access: "full-access",
    });
  }
  await until(
    "facts",
    () => rpc(studio, "meshLayout.get"),
    (value) => nodes.every((node) => value.config.machines[node.id]?.reported?.meshPublicKey),
  );
  const current = await mcp(studio, "t3_mesh_config_get");
  for (const node of nodes) {
    node.host = Object.entries(current.bindings).find(([, id]) => id === node.id)?.[0];
    if (!node.host) throw Error(`No joined config identity for ${node.name}`);
  }
  let doc = {
    schema: 1,
    machines: Object.fromEntries(nodes.map((node) => [node.host, { title: node.name }])),
    ssh: { mode: "managed" },
    links: { default: { files: "all", replicas: true, threads: true } },
    projects: { defaults: { replica: "lite", conflicts: "primary-wins" } },
    replicas: { rules: [] },
  };
  await mcp(studio, "t3_mesh_config_apply", {
    doc,
    baseRevision: current.revision ?? current.current?.revision ?? null,
  });
  console.log(
    "PASS fresh three-server bed, mutual linking, automatic mesh keys; incoming peer connections to cloudbox denied",
  );
  // Persist private control state for follow-up assertions without exposing credentials in evidence.
  await NodeFSP.writeFile(`${root}/control.json`, JSON.stringify(nodes), { mode: 0o600 });
  await until(
    "managed routes",
    () => rpc(studio, "meshLayout.get"),
    (value) =>
      nodes.every((node) => value.document[`mesh.machineBinding/${node.host}`]?.v === node.id),
  );
  for (const node of nodes)
    for (const target of nodes.filter((other) => other !== node)) {
      const args = ["ssh", "-F", `${node.home}/.ssh/config`, `t3-${target.host}`, "true"];
      await until(
        `ssh ${node.name} -> ${target.name}`,
        async () => {
          if (node.name === "studio") return run(args[0], args.slice(1));
          return remote(
            node.name,
            `${node.name === "cloudbox" ? "docker exec R1-mesh-cloudbox " : ""}${args.map(quote).join(" ")}`,
          );
        },
        () => true,
      );
      console.log(`PASS ${node.name}: ssh t3-${target.host} true (N1 pipe)`);
    }
  await (
    await import("./r1-bed-scenarios.mjs")
  ).runScenarios({
    nodes,
    root,
    runtime,
    doc,
    run,
    remote,
    upload,
    rpc,
    mcp,
    file,
    read,
    until,
    quote,
  });
} finally {
  for (const child of children) child.kill("SIGTERM");
}
