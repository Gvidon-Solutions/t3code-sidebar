import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import { run, until, rpc, mcp } from "./client.mjs";
const studioUnit = (
  await run("bash", [
    "-c",
    'source "$1"; printf "%s" "$STUDIO_UNIT"',
    "bed-config",
    new URL("bed-config.sh", import.meta.url).pathname,
  ])
).trim();
const root = process.env.B1_BED_ROOT ?? "/tmp/B1-bed";
const releases = process.env.B1_RELEASES ?? "/tmp/B1-releases";
const admin = {
  laptop: JSON.parse(process.env.B1_LAPTOP_SSH ?? "null"),
  cloudbox: JSON.parse(process.env.B1_CLOUDBOX_SSH ?? "null"),
};
if (!admin.laptop || !admin.cloudbox)
  throw Error(
    "B1_LAPTOP_SSH and B1_CLOUDBOX_SSH must be SSH argument arrays for the two remote bed roles",
  );
for (const name of ["laptop", "cloudbox"]) {
  const args = admin[name];
  admin[name] = [
    ...args.slice(0, -1),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=no",
    args.at(-1),
  ];
}
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const remote = (name, command) => run("ssh", [...admin[name], command]);
const upload = async (name, source, destination) => {
  const bytes = await NodeFSP.readFile(source);
  await new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("ssh", [...admin[name], `cat > ${quote(destination)}`]);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(Error(`Upload exited ${code}`))));
    child.stdin.end(bytes);
  });
};
const nodes = [
  {
    name: "studio",
    base: `${root}/studio/state`,
    home: `${root}/studio/home`,
    port: 3795,
    sshPort: 22295,
    origin: "http://127.0.0.1:3795",
  },
  {
    name: "laptop",
    base: `${root}/laptop/state`,
    home: `${root}/laptop/home`,
    port: 3799,
    sshPort: 22298,
    origin: "http://127.0.0.1:14899",
  },
  {
    name: "cloudbox",
    base: "/root/.t3-mesh",
    home: "/root",
    port: 3822,
    sshPort: 22299,
    origin: "http://127.0.0.1:14893",
  },
];
const [studio, laptop, cloudbox] = nodes;
const shell = (node, command) =>
  node.name === "studio"
    ? run("bash", ["-c", command])
    : remote(
        node.name,
        node.name === "cloudbox" ? `docker exec B1-bootstrap sh -c ${quote(command)}` : command,
      );
for (const node of nodes)
  node.cli = (args) =>
    shell(
      node,
      `HOME=${quote(node.home)} ${quote(`${node.base}/runtime/versions/0.1.5/t3`)} ${[...args, "--base-dir", node.base].map(quote).join(" ")}`,
    );
const children = [];
const releaseServer = NodeHttp.createServer(async (request, response) => {
  const path = NodePath.resolve(releases, "." + new URL(request.url, "http://fixture").pathname);
  if (!path.startsWith(releases + "/") || !/\/(SHA256SUMS|t3-[\w.+-]+\.tar\.gz)$/.test(path)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const data = await NodeFSP.readFile(path);
    response.writeHead(200, { "content-length": data.length }).end(data);
  } catch (error) {
    if (error.code !== "ENOENT") console.error(error);
    response.writeHead(404).end();
  }
});
let stoppedBed = false;
try {
  await remote(
    "cloudbox",
    "test \"$(cat /tmp/mesh-bed.lock/owner)\" = B1; docker exec B1-bootstrap sh -c 'test ! -e /root/.t3-mesh; ! command -v t3; ! command -v node; systemctl is-active ssh'",
  );
  console.log("PASS fresh container: sshd active; no T3 or Node");
  await NodeFSP.mkdir(root, { recursive: true });
  await new Promise((resolve) => releaseServer.listen(14890, "127.0.0.1", resolve));
  const active = await run("systemctl", ["--user", "is-active", studioUnit]);
  if (active === "active") {
    await run("systemctl", ["--user", "stop", studioUnit]);
    stoppedBed = true;
  }
  for (const node of nodes.slice(0, 2)) {
    const mkdir = `mkdir -p ${quote(node.base + "/runtime/versions/0.1.5")} ${quote(node.base + "/userdata")} ${quote(node.home)}`;
    await shell(node, mkdir);
    if (node.name === "laptop") {
      await upload(
        node.name,
        `${releases}/v0.1.5/t3-0.1.5-linux-x64.tar.gz`,
        `${root}/runtime.tar.gz`,
      );
      await upload(
        node.name,
        NodePath.resolve("scripts/mesh-e2e/managed-sshd.mjs"),
        `${root}/managed-sshd.mjs`,
      );
    }
    const tar =
      node.name === "studio"
        ? `${releases}/v0.1.5/t3-0.1.5-linux-x64.tar.gz`
        : `${root}/runtime.tar.gz`;
    const settings = JSON.stringify({
      meshEnabled: true,
      replicasEnabled: true,
      linkedEnvironmentsEnabled: true,
      replicaRoot: `${node.home}/replicas`,
    });
    await shell(
      node,
      `tar -xzf ${quote(tar)} -C ${quote(node.base + "/runtime/versions/0.1.5")} --strip-components=1; printf '0.1.5\\n' > ${quote(node.base + "/runtime/versions/0.1.5/.install-complete")}; printf '%s' '${JSON.stringify({ protocol: 3, activeVersion: "0.1.5" })}' > ${quote(node.base + "/runtime/service-state.json")}; printf '%s' ${quote(settings)} > ${quote(node.base + "/userdata/settings.json")}; mkdir -p ${quote(node.home + "/sshd")} ${quote(node.home + "/.ssh")}; test -f ${quote(node.home + "/sshd/ssh_host_ed25519_key")} || ssh-keygen -q -t ed25519 -N '' -f ${quote(node.home + "/sshd/ssh_host_ed25519_key")}; printf '%s' ${quote(`Port ${node.sshPort}\nListenAddress 127.0.0.1\nHostKey ${node.home}/sshd/ssh_host_ed25519_key\nPidFile ${node.home}/sshd/pid\nAuthorizedKeysFile ${node.home}/.ssh/authorized_keys\nStrictModes no\nPasswordAuthentication no\nUsePAM no\nSubsystem sftp internal-sftp\n`.replaceAll("\\n", "\n"))} > ${quote(node.home + "/sshd/sshd_config")}`,
    );
    const variables = {
      HOME: node.home,
      ...(node.name === "studio" && process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      T3CODE_HOME: node.base,
      T3_MESH_AGENT_HOME: node.home,
      T3_MESH_SSH_HOME: node.home,
      T3_MESH_SSHD_DIR: `${node.home}/sshd`,
      T3CODE_RELEASE_BASE_URL: "http://127.0.0.1:14890",
      T3CODE_PORT: String(node.port),
      T3CODE_HOST: "127.0.0.1",
      T3CODE_NO_BROWSER: "true",
      T3_MESH_TEST_MODE: "1",
      ...(node.name === "laptop" ? { T3_MESH_TEST_FAIL_HEALTH_VERSION: "0.1.6" } : {}),
    };
    for (const [suffix, command, env] of [
      ["sshd", `/usr/sbin/sshd -D -e -f ${node.home}/sshd/sshd_config`, {}],
      ["server", `${node.base}/runtime/versions/0.1.5/t3 __service-launcher`, variables],
    ]) {
      const name = `B1-${node.name}-${suffix}`;
      const unit = `[Unit]\nDescription=B1 isolated ${node.name} ${suffix}\n[Service]\nExecStart=${command}\n${Object.entries(
        env,
      )
        .map(([key, value]) => `Environment=${key}=${value}`)
        .join("\n")}\n`;
      const directory =
        node.name === "studio" ? "$HOME/.config/systemd/user" : "/etc/systemd/system";
      const scope = node.name === "studio" ? "--user" : "";
      await shell(
        node,
        `mkdir -p ${directory}; printf '%s' ${quote(unit)} > ${directory}/${name}.service; systemctl ${scope} daemon-reload; systemctl ${scope} start ${name}`,
      );
    }
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
        name === "laptop" ? "14899:127.0.0.1:3799" : "14893:127.0.0.1:3822",
        ...(name === "cloudbox" ? ["-L", "14891:127.0.0.1:22299"] : []),
        "-R",
        "14890:127.0.0.1:14890",
        "-R",
        "14895:127.0.0.1:3795",
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    children.push(child);
  }
  for (const node of nodes.slice(0, 2)) {
    node.id = (
      await until(
        `${node.name} descriptor`,
        async () => (await fetch(`${node.origin}/.well-known/t3/environment`)).json(),
        (value) => !!value.environmentId,
      )
    ).environmentId;
    node.token = (
      await node.cli([
        "auth",
        "session",
        "issue",
        "--ttl",
        "1h",
        "--label",
        "B1-bed",
        "--token-only",
      ])
    ).split("\n")[0];
  }
  const pairing = JSON.parse(
    await studio.cli(["auth", "pairing", "create", "--ttl", "10m", "--label", "B1-bed", "--json"]),
  );
  await rpc(laptop, "peerLinks.link", {
    url: "http://127.0.0.1:14895",
    pairingCode: pairing.credential,
    access: "full-access",
  });
  await until(
    "mutual facts",
    () => rpc(studio, "meshConfig.get"),
    (value) => Object.values(value.bindings).includes(laptop.id),
  );
  const projectRoot = `${root}/studio/B1-project`;
  await NodeFSP.mkdir(projectRoot, { recursive: true });
  await run("git", ["init", "-q", projectRoot]);
  await NodeFSP.writeFile(`${projectRoot}/README.md`, "B1-bootstrap-replica\n");
  const project = await mcp(studio, "t3_project_create", {
    title: "B1-bootstrap",
    workspaceRoot: projectRoot,
  });
  await mcp(studio, "t3_project_place", {
    project: project.id,
    machine: studio.id,
    role: "primary",
    path: projectRoot,
  });
  const observed = await rpc(studio, "meshConfig.get");
  const renamed = {
    ...observed.current.doc,
    machines: Object.fromEntries(
      [studio, laptop].map((node) => [
        node.name,
        observed.current.doc.machines[
          Object.keys(observed.bindings).find((name) => observed.bindings[name] === node.id)
        ],
      ]),
    ),
  };
  await rpc(studio, "meshConfig.apply", { doc: renamed, baseRevision: observed.current.revision });
  const before = await rpc(studio, "meshConfig.get");
  const doc = {
    ...before.current.doc,
    machines: {
      studio: {
        title: "studio",
        label: "ST",
        ssh: { user: process.env.USER, port: studio.sshPort },
      },
      laptop: { title: "laptop", label: "LP", ssh: { user: "root", port: laptop.sshPort } },
      cloudbox: {
        title: "cloudbox",
        label: "CB",
        bootstrap: { ssh: "root@127.0.0.1:14891", port: 3822 },
        reach: { address: cloudbox.origin },
        ssh: { user: "root", port: cloudbox.sshPort },
      },
    },
    replicas: {
      ...before.current.doc.replicas,
      rules: [{ project: "B1-bootstrap", on: "cloudbox", when: "always" }],
    },
  };
  await rpc(studio, "meshConfig.apply", { doc, baseRevision: before.current.revision });
  // Exercise the credential API with an ephemeral test-only identity. No password enters layout/config/logs.
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", `${root}/bootstrap-key`]);
  const publicKey = await NodeFSP.readFile(`${root}/bootstrap-key.pub`, "utf8");
  await remote(
    "cloudbox",
    `docker exec B1-bootstrap sh -c ${quote(`mkdir -p /root/.ssh; chmod 700 /root/.ssh; printf '%s' ${quote(publicKey)} > /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys`)}`,
  );
  await mcp(studio, "t3_mesh_bootstrap_credential", {
    name: "cloudbox",
    kind: "key",
    identityFile: `${root}/bootstrap-key`,
  });
  const joined = await until(
    "bootstrap binding",
    () => rpc(studio, "meshConfig.get"),
    (value) => !!value.bindings.cloudbox,
  );
  cloudbox.id = joined.bindings.cloudbox;
  cloudbox.token = (
    await cloudbox.cli([
      "auth",
      "session",
      "issue",
      "--ttl",
      "1h",
      "--label",
      "B1-bed",
      "--token-only",
    ])
  ).split("\n")[0];
  console.log(
    "PASS bootstrap from config",
    JSON.stringify({
      bindings: joined.bindings,
      version: (await mcp(cloudbox, "t3_mesh_update_health")).version,
    }),
  );
  const replica = await until(
    "rule replica watching",
    () => rpc(studio, "meshLayout.get"),
    (value) => {
      const key = Object.keys(value.config.projectTitles).find(
        (key) => value.config.projectTitles[key] === "B1-bootstrap",
      );
      return value.config.projectMountStatus[key]?.[cloudbox.id]?.state === "watching";
    },
  );
  const key = Object.keys(replica.config.projectTitles).find(
    (key) => replica.config.projectTitles[key] === "B1-bootstrap",
  );
  const target = replica.config.projectMounts[key].find((rep) => rep.environmentId === cloudbox.id);
  const content = await shell(
    cloudbox,
    `cat ${quote(target.path + "/README.md")}; test ! -e ${quote(target.path + "/.git")}`,
  );
  if (content !== "B1-bootstrap-replica") throw Error("Replica file mismatch");
  console.log(
    "PASS config rule places real replica",
    JSON.stringify({ machine: "cloudbox", state: "watching", file: content }),
  );
  await shell(
    cloudbox,
    `printf '\nT3CODE_RELEASE_BASE_URL=http://127.0.0.1:14890\n' >> ${quote(cloudbox.base + "/service.env")}`,
  );
  const plan = await mcp(studio, "t3_mesh_update", { version: "0.1.6", plan: true });
  console.log(
    "update plan",
    JSON.stringify({
      version: plan.doc.t3.version,
      actions: plan.actions.filter((action) => action.id.startsWith("updates/")),
    }),
  );
  await mcp(studio, "t3_mesh_update", { version: "0.1.6" });
  await until(
    "failed rollout and rollback",
    () => shell(laptop, `cat ${quote(laptop.base + "/runtime/service-state.json")}`),
    (text) => {
      const value = JSON.parse(text);
      return value.activeVersion === "0.1.5" && value.update?.status === "rolled-back";
    },
    300000,
  );
  const final = await until(
    "stop marker",
    () => rpc(studio, "meshLayout.get"),
    (value) =>
      Object.entries(value.document).some(
        ([key, entry]) => key.startsWith("mesh.updateFailure/") && entry.v,
      ),
  );
  for (const node of nodes) {
    delete node.mcpInitialized;
    delete node.mcpSession;
  }
  const versions = {};
  for (const node of nodes)
    versions[node.name] = (await mcp(node, "t3_mesh_update_health")).version;
  if (versions.cloudbox !== "0.1.6" || versions.laptop !== "0.1.5" || versions.studio !== "0.1.5")
    throw Error(`Wrong rollout result ${JSON.stringify(versions)}`);
  const untouched = JSON.parse(
    await shell(studio, `cat ${quote(studio.base + "/runtime/service-state.json")}`),
  );
  if (untouched.update !== undefined)
    throw Error("The final server was updated after the rollout failed");
  await shell(studio, `test ! -e ${quote(studio.base + "/runtime/mesh-rollout.json")}`);
  console.log(
    "PASS three-server rollout: cloudbox updated, laptop rolled back, studio untouched",
    JSON.stringify(versions),
  );
  console.log(
    "failure",
    JSON.stringify(
      Object.fromEntries(
        Object.entries(final.document).filter(
          ([key, entry]) => key.startsWith("mesh.updateFailure/") && entry.v,
        ),
      ),
    ),
  );
  for (const node of [cloudbox, laptop])
    console.log(
      `${node.name} DB backup`,
      await shell(
        node,
        `find ${quote(node.base + "/runtime/mesh-backup")} -name statev2.sqlite -type f`,
      ),
    );
  const status = await until(
    "rollout stopped status on every server",
    () => mcp(studio, "t3_mesh_status"),
    (value) =>
      value.servers.every((server) =>
        server.actions.some(
          (action) =>
            action.id === "updates/runtime" &&
            action.state === "failed" &&
            action.reason?.includes("Injected mesh rollout health failure"),
        ),
      ),
  );
  console.log(
    "status",
    JSON.stringify(
      status.servers.map((server) => ({
        environmentId: server.environmentId,
        actions: server.actions.filter(
          (action) => action.id.startsWith("updates/") || action.id.startsWith("bootstrap/"),
        ),
      })),
    ),
  );
  console.log("PASS B1 bootstrap and serial rollout rollback acceptance");
} finally {
  for (const child of children) child.kill("SIGTERM");
  await new Promise((resolve) => releaseServer.close(resolve));
  for (const node of nodes.slice(0, 2)) {
    try {
      await shell(
        node,
        `systemctl ${node.name === "studio" ? "--user" : ""} stop B1-${node.name}-server B1-${node.name}-sshd`,
      );
    } catch (error) {
      console.error("Cleanup", error.message);
    }
  }
  if (stoppedBed) await run("systemctl", ["--user", "start", studioUnit]);
}
