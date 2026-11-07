import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeStreamPromises from "node:stream/promises";
const repo = NodePath.resolve(import.meta.dirname, "../..");
const root = process.env.S1_BED_ROOT ?? "/tmp/S1-bed";
const runtime = process.env.S1_BED_RUNTIME;
if (!runtime) throw Error("S1_BED_RUNTIME must name an assembled runtime directory");
const admin = {
  laptop: JSON.parse(process.env.S1_LAPTOP_SSH ?? "null"),
  cloudbox: JSON.parse(process.env.S1_CLOUDBOX_SSH ?? "null"),
};
if (!admin.laptop || !admin.cloudbox)
  throw Error("S1_LAPTOP_SSH and S1_CLOUDBOX_SSH must contain administrator SSH argument arrays");
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
const image = process.env.S1_BED_IMAGE ?? "t3-mesh-e2e:n1";
const unit = (name, command, environment) =>
  `[Unit]\nDescription=S1 isolated mesh ${name}\n[Service]\nExecStart=${command}\n${Object.entries(
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
    return remote(node.name, `docker exec S1-mesh-cloudbox ${command.map(quote).join(" ")}`);
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
          if (message._tag === "Exit" && message.requestId === "S1") {
            clearTimeout(timer);
            if (message.exit._tag === "Success") resolve(message.exit.value);
            else reject(Error(JSON.stringify(message.exit.cause)));
          }
        }
      };
      ws.send(JSON.stringify({ _tag: "Request", id: "S1", tag, payload, headers: [] }));
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
      await cli(node, ["auth", "pairing", "create", "--ttl", "10m", "--label", "S1-mcp", "--json"]),
    );
    const meta = await json("/.well-known/oauth-protected-resource/mcp");
    const redirect = "http://127.0.0.1:1/S1-callback";
    const client = await json("/oauth/mcp/register", {
      client_name: "S1-bed",
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
        id: "S1-init",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "S1-bed", version: "1" },
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
      id: "S1",
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
      `${node.name === "cloudbox" ? "docker exec S1-mesh-cloudbox " : ""}node -e ${quote(script)}`,
    );
  }
};
const read = (node, path) =>
  node.name === "studio"
    ? NodeFSP.readFile(path, "utf8")
    : remote(
        node.name,
        `${node.name === "cloudbox" ? "docker exec S1-mesh-cloudbox " : ""}cat ${quote(path)}`,
      );
try {
  await NodeFSP.mkdir(root, { recursive: true });
  if (process.env.S1_BED_REUSE !== "1") {
    // The caller holds /tmp/mesh-bed.lock. Own directories only; no pairing keys are provisioned here.
    for (const name of ["laptop", "cloudbox"]) {
      console.log(`S1 deploy runtime to ${name}`);
      await remote(name, `mkdir -p ${quote(root)}`);
      const tar = `${root}/runtime.tar.gz`;
      const packed = `${root}/upload-runtime.tar.gz`;
      await run("tar", ["-czf", packed, "-C", runtime, "."]);
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
        ...(node.name === "studio" && process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        T3_MESH_SSH_HOME: node.home,
        T3_MESH_SSHD_DIR: `${node.home}/sshd`,
      };
      const units = [
        [
          `S1-mesh-${node.name}-sshd`,
          unit(node.name, `/usr/sbin/sshd -D -e -f ${node.home}/sshd/sshd_config`, {}),
        ],
        [
          `S1-mesh-${node.name}`,
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
      `docker run -d --name S1-mesh-cloudbox --network host --user 10001:10001 -e HOME=/bed/home -e PATH=/bed/fake-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -e T3_MESH_SSH_HOME=/bed/home -e T3_MESH_SSHD_DIR=/bed/home/sshd -v ${quote(root + ":/bed")} ${quote(image)} sh -c ${quote(launch)}`,
    );
  } else {
    console.log("S1 update owned runtimes");
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
          ? "systemctl --user restart S1-mesh-laptop.service"
          : "docker restart S1-mesh-cloudbox >/dev/null",
      );
    }
    await run("systemctl", ["--user", "restart", "S1-mesh-studio.service"]);
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
        "S1-bed",
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
        "S1-bed",
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
            `${node.name === "cloudbox" ? "docker exec S1-mesh-cloudbox " : ""}${args.map(quote).join(" ")}`,
          );
        },
        () => true,
      );
      console.log(`PASS ${node.name}: ssh t3-${target.host} true (N1 pipe)`);
    }
  console.log("S1_CONTROL=" + root + "/control.json");
  const apply = async (next) => {
    const state = await mcp(studio, "t3_mesh_config_get");
    await mcp(studio, "t3_mesh_config_apply", { doc: next, baseRevision: state.current.revision });
    doc = next;
  };
  const source = `${root}/studio/S1-primary`;
  await file(studio, `${source}/README.md`, "S1 primary version");
  await file(studio, `${source}/src/build/source.ts`, "nested build source");
  await file(studio, `${source}/build/generated`, "ignored output");
  await file(studio, `${source}/node_modules/dependency`, "ignored dependency");
  const project = await mcp(studio, "t3_project_create", {
    title: "S1-primary",
    workspaceRoot: source,
  });
  await mcp(studio, "t3_project_place", {
    project: project.id,
    machine: studio.id,
    role: "primary",
    path: source,
  });
  const projectState = await mcp(studio, "t3_project_machines", { project: project.id });
  const key = projectState.logicalKey;
  await apply({
    ...doc,
    replicas: {
      rules: nodes
        .slice(1)
        .map((node) => ({ project: "S1-primary", on: node.host, when: "always" })),
    },
  });
  for (const node of nodes.slice(1)) {
    const mounted = await until(
      `${node.name} rule replica`,
      () => mcp(node, "t3_project_machines", { project: key }),
      (value) =>
        value.representations?.some(
          (rep) => rep.environmentId === node.id && rep.status?.state === "watching",
        ),
    );
    node.replica = mounted.representations.find((rep) => rep.environmentId === node.id);
    node.session = node.replica.live?.sessionName;
    if (!node.session)
      node.session = (await rpc(node, "replicas.status")).replicas.find(
        (rep) => rep.logicalKey === key && rep.environmentId === node.id,
      ).sessionName;
    if ((await read(node, `${node.replica.path}/README.md`)) !== "S1 primary version")
      throw Error("Initial sync mismatch");
    if ((await read(node, `${node.replica.path}/src/build/source.ts`)) !== "nested build source")
      throw Error("Nested build source ignored");
    const check = `test ! -e ${quote(node.replica.path + "/build")} && test ! -e ${quote(node.replica.path + "/node_modules")}`;
    await remote(
      node.name,
      `${node.name === "cloudbox" ? "docker exec S1-mesh-cloudbox sh -c " : "sh -c "}${quote(check)}`,
    );
    console.log(
      `PASS ${node.name} config rule: replica driver, nested build included, root build/node_modules excluded`,
    );
  }
  const mutate = async (node, action) => {
    const args = [`${root}/runtime/mutagen`, "sync", action, node.session];
    return remote(
      node.name,
      `${node.name === "cloudbox" ? "docker exec -e MUTAGEN_DATA_DIRECTORY=/bed/state/mutagen S1-mesh-cloudbox /bed/runtime/mutagen sync " + action + " " + quote(node.session) : "MUTAGEN_DATA_DIRECTORY=" + quote(node.base + "/mutagen") + " " + args.map(quote).join(" ")}`,
    );
  };
  const laptop = nodes[1];
  await mutate(laptop, "pause");
  await file(studio, `${source}/README.md`, "S1 primary wins");
  await file(laptop, `${laptop.replica.path}/README.md`, "S1 replica loses");
  await mutate(laptop, "resume");
  await mutate(laptop, "flush");
  await until(
    "primary-wins",
    () => read(laptop, `${laptop.replica.path}/README.md`),
    (value) => value === "S1 primary wins",
  );
  const archiveContains = async (node, rootPath, contents) => {
    const script = `const fs=require('node:fs'),path=require('node:path');let found=false;function walk(p){if(!fs.existsSync(p))return;for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,e.name);if(e.isDirectory()){if(e.name.includes(':'))throw Error('Unsafe conflict timestamp');walk(f)}else if(fs.readFileSync(f,'utf8')===${JSON.stringify(contents)})found=true}}walk(${JSON.stringify(rootPath + "/.t3-conflicts")});if(!found)process.exit(1)`;
    if (node.name === "studio") return run("node", ["-e", script]);
    return remote(
      node.name,
      `${node.name === "cloudbox" ? "docker exec S1-mesh-cloudbox " : ""}node -e ${quote(script)}`,
    );
  };
  await archiveContains(laptop, laptop.replica.path, "S1 replica loses");
  console.log("PASS primary-wins: beta loser preserved under Windows-safe .t3-conflicts timestamp");
  await apply({ ...doc, projects: { defaults: { replica: "lite", conflicts: "newest-wins" } } });
  await mutate(laptop, "pause");
  await file(studio, `${source}/README.md`, "S1 primary loses");
  await file(laptop, `${laptop.replica.path}/README.md`, "S1 newest replica wins");
  await run("node", [
    "-e",
    `require('node:fs').utimesSync(${JSON.stringify(source + "/README.md")},100,100)`,
  ]);
  await remote(
    "laptop",
    `node -e ${quote(`require('node:fs').utimesSync(${JSON.stringify(laptop.replica.path + "/README.md")},200,200)`)}`,
  );
  await mutate(laptop, "resume");
  await mutate(laptop, "flush");
  await until(
    "newest-wins",
    () => read(studio, `${source}/README.md`),
    (value) => value === "S1 newest replica wins",
  );
  await archiveContains(studio, source, "S1 primary loses");
  console.log(
    "PASS newest-wins: alpha loser preserved; replica's newer version converged to primary",
  );
  // Removing a rule cannot delete files or a representation; removal stays explicit.
  await apply({
    ...doc,
    replicas: { rules: [{ project: "S1-primary", on: nodes[2].host, when: "always" }] },
  });
  await mutate(laptop, "pause");
  await file(laptop, `${laptop.replica.path}/unsynced.txt`, "S1 unsynced change");
  let refused = false;
  try {
    await mcp(laptop, "t3_project_place", { project: key, machine: laptop.id, action: "remove" });
  } catch (error) {
    if (!error.message.includes("unsynced.txt")) throw error;
    refused = true;
  }
  if (!refused) throw Error("Removal accepted unsynced files");
  await mutate(laptop, "resume");
  await mutate(laptop, "flush");
  await until(
    "clean before removal",
    () => read(studio, `${source}/unsynced.txt`),
    (value) => value === "S1 unsynced change",
  );
  await until(
    "watching before removal",
    () => mcp(laptop, "t3_project_machines", { project: key }),
    (value) =>
      value.representations.find((rep) => rep.environmentId === laptop.id)?.live?.state ===
      "watching",
  );
  await mcp(laptop, "t3_project_place", { project: key, machine: laptop.id, action: "remove" });
  if ((await read(laptop, `${laptop.replica.path}/unsynced.txt`)) !== "S1 unsynced change")
    throw Error("Removal deleted files");
  console.log(
    "PASS explicit removal: unsynced.txt refused with path; clean removal kept replica files",
  );
  const cloudbox = nodes[2];
  await file(
    cloudbox,
    "/bed/fake-bin/pnpm",
    `#!/usr/bin/env node
const fs = require('node:fs');
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['install','--frozen-lockfile'])) throw Error('Unexpected package-manager arguments');
fs.mkdirSync('.t3',{recursive:true});
const count = '.t3/fake-install-count';
fs.writeFileSync(count,String((fs.existsSync(count) ? Number(fs.readFileSync(count,'utf8')) : 0)+1));
fs.writeFileSync('.t3/installed-lock',fs.readFileSync('pnpm-lock.yaml'));
`,
  );
  await remote("cloudbox", "docker exec S1-mesh-cloudbox chmod 755 /bed/fake-bin/pnpm");
  const fullSource = `${root}/studio/S1-full`;
  await file(studio, `${fullSource}/pnpm-lock.yaml`, "S1 initial environment lock");
  const fullProject = await mcp(studio, "t3_project_create", {
    title: "S1-full",
    workspaceRoot: fullSource,
  });
  await mcp(studio, "t3_project_place", {
    project: fullProject.id,
    machine: studio.id,
    role: "primary",
    path: fullSource,
  });
  const fullKey = (await mcp(studio, "t3_project_machines", { project: fullProject.id }))
    .logicalKey;
  await apply({
    ...doc,
    projects: { ...doc.projects, overrides: [{ project: "S1-full", replica: "full" }] },
    replicas: {
      rules: [...doc.replicas.rules, { project: "S1-full", on: cloudbox.host, when: "always" }],
    },
  });
  const fullState = await until(
    "full environment ready",
    () => mcp(cloudbox, "t3_project_machines", { project: fullKey }),
    (value) =>
      value.representations?.some(
        (rep) => rep.environmentId === cloudbox.id && rep.status?.message === "environment: ready",
      ),
  );
  const fullReplica = fullState.representations.find((rep) => rep.environmentId === cloudbox.id);
  if ((await read(cloudbox, `${fullReplica.path}/.t3/fake-install-count`)) !== "1")
    throw Error("Full environment was not installed exactly once");
  await file(studio, `${fullSource}/pnpm-lock.yaml`, "S1 refreshed environment lock");
  await until(
    "full environment refreshed",
    () => read(cloudbox, `${fullReplica.path}/.t3/installed-lock`),
    (value) => value === "S1 refreshed environment lock",
  );
  if ((await read(cloudbox, `${fullReplica.path}/.t3/fake-install-count`)) !== "2")
    throw Error("Full lock change was not installed exactly once");
  await until(
    "refreshed full environment ready status",
    () => mcp(cloudbox, "t3_project_machines", { project: fullKey }),
    (value) =>
      value.representations?.some(
        (rep) => rep.environmentId === cloudbox.id && rep.status?.message === "environment: ready",
      ),
  );
  console.log(
    "PASS full mode: fake pnpm executed once, lock change reinstalled once, environment: ready",
  );
  await NodeFSP.writeFile(`${root}/control.json`, JSON.stringify(nodes), { mode: 0o600 });
  console.log("PASS S1 fresh-bed managed SSH and replicas acceptance");
  if (process.env.S1_KEEP_BED === "1") await new Promise(() => {});
} finally {
  for (const child of children) child.kill("SIGTERM");
}
