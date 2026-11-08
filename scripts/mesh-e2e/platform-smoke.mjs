/* oxlint-disable t3code/no-global-process-runtime -- Standalone native-platform acceptance fixture. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import { run, until, rpc, mcp } from "../mesh-fast/client.mjs";
import { writeManagedSshdConfig } from "../lib/managed-sshd.mjs";
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-platform-"));
const bin = NodePath.resolve("apps/server/dist/bin.mjs");
const children = [];
const logs = [];
const sshServices = [];
const powershell = (script) =>
  run("powershell.exe", [
    "-NoLogo",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);
const windows = process.platform === "win32";
const sshd = windows
  ? NodePath.join(process.env.SystemRoot, "System32/OpenSSH/sshd.exe")
  : "/usr/sbin/sshd";
const nodes = ["studio", "laptop"].map((name, index) => ({
  name,
  home: NodePath.join(root, name, "home"),
  base: NodePath.join(root, name, "state"),
  port: 13951 + index,
  sshPort: 22951 + index,
  origin: `http://127.0.0.1:${13951 + index}`,
}));
const launch = (command, args, env) => {
  const child = NodeChildProcess.spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.on("error", (error) => logs.push(error.message));
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => logs.push(data.toString()));
  return child;
};
try {
  for (const node of nodes) {
    const directory = NodePath.join(node.home, "sshd");
    await NodeFSP.mkdir(NodePath.join(node.base, "userdata"), { recursive: true });
    const confFile = await writeManagedSshdConfig({
      home: node.home,
      port: node.sshPort,
      directory,
      pidPath: NodePath.join(directory, "pid"),
      allowUsers: null,
      usePam: !windows,
      quotePaths: true,
      toSshPath: (path) => path.replaceAll("\\", "/"),
      extraLines: [`SetEnv ${JSON.stringify(`PATH=${process.env.PATH ?? ""}`)}`],
    });
    if (windows) {
      const service = `mesh-sshd-${process.pid}-${node.name}`;
      const command = `"${sshd}" -f "${confFile}"`;
      await powershell(
        `$ErrorActionPreference='Stop'; New-Service -Name '${service}' -BinaryPathName '${command.replaceAll("'", "''")}'; Start-Service '${service}'`,
      );
      sshServices.push(service);
    } else launch(sshd, ["-D", "-e", "-f", confFile], {});
    await NodeFSP.writeFile(
      NodePath.join(node.base, "userdata/settings.json"),
      JSON.stringify({
        meshEnabled: true,
        linkedEnvironmentsEnabled: true,
        replicasEnabled: true,
        replicaRoot: NodePath.join(node.home, "replicas"),
      }),
    );
    const env = {
      HOME: node.home,
      USERPROFILE: node.home,
      T3_MESH_AGENT_HOME: node.home,
      T3_MESH_SSH_HOME: node.home,
      T3_MESH_SSHD_DIR: directory,
    };
    node.cli = (args) =>
      run(process.execPath, [bin, ...args, "--base-dir", node.base], {
        env: { ...process.env, ...env },
      });
    launch(
      process.execPath,
      [
        bin,
        "serve",
        "--base-dir",
        node.base,
        "--host",
        "127.0.0.1",
        "--port",
        String(node.port),
        "--no-browser",
      ],
      env,
    );
    node.id = (
      await until(
        `${node.name} startup`,
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
        "10m",
        "--label",
        "mesh-platform",
        "--token-only",
      ])
    ).split("\n")[0];
  }
  const [studio, laptop] = nodes;
  const pair = JSON.parse(
    await studio.cli([
      "auth",
      "pairing",
      "create",
      "--ttl",
      "10m",
      "--label",
      "mesh-platform",
      "--json",
    ]),
  );
  await rpc(laptop, "peerLinks.link", {
    url: studio.origin,
    pairingCode: pair.credential,
    access: "full-access",
  });
  const current = await until(
    "paired mesh",
    () => rpc(studio, "meshConfig.get"),
    (value) => nodes.every((node) => Object.values(value.bindings).includes(node.id)),
  );
  const names = Object.fromEntries(
    nodes.map((node) => [
      node.name,
      Object.keys(current.bindings).find((name) => current.bindings[name] === node.id),
    ]),
  );
  const projectRoot = NodePath.join(studio.home, "mesh-platform-project");
  await NodeFSP.mkdir(projectRoot);
  await run("git", ["init", "-q", projectRoot]);
  await NodeFSP.writeFile(NodePath.join(projectRoot, "README.md"), "mesh-platform-replica\n");
  const project = await mcp(studio, "t3_project_create", {
    title: "mesh-platform",
    workspaceRoot: projectRoot,
  });
  await mcp(studio, "t3_project_place", {
    project: project.id,
    machine: studio.id,
    role: "primary",
    path: projectRoot,
  });
  const latest = await rpc(studio, "meshConfig.get");
  const doc = {
    ...latest.current.doc,
    machines: Object.fromEntries(
      nodes.map((node) => [
        names[node.name],
        {
          ...latest.current.doc.machines[names[node.name]],
          ssh: { user: NodeOS.userInfo().username, port: node.sshPort },
        },
      ]),
    ),
    links: { default: { files: "all", replicas: true, threads: true } },
    replicas: { rules: [{ project: "mesh-platform", on: names.laptop, when: "always" }] },
  };
  await rpc(studio, "meshConfig.apply", { doc, baseRevision: latest.current.revision });
  const snapshot = await until(
    "native replica watching",
    () => rpc(studio, "meshLayout.get"),
    (value) => {
      const key = Object.keys(value.config.projectTitles).find(
        (key) => value.config.projectTitles[key] === "mesh-platform",
      );
      return value.config.projectMountStatus[key]?.[laptop.id]?.state === "watching";
    },
  );
  const key = Object.keys(snapshot.config.projectTitles).find(
    (key) => snapshot.config.projectTitles[key] === "mesh-platform",
  );
  const target = snapshot.config.projectMounts[key].find((rep) => rep.environmentId === laptop.id);
  if (
    (await NodeFSP.readFile(NodePath.join(target.path, "README.md"), "utf8")) !==
    "mesh-platform-replica\n"
  )
    throw Error("Replica content mismatch");
  // Exercise the built bundle's serialized worker in both foreground and background modes.
  const replicaRun = (args) =>
    run(process.execPath, [bin, "run", ...args], {
      cwd: target.path,
      env: {
        ...process.env,
        HOME: laptop.home,
        USERPROFILE: laptop.home,
        T3CODE_HOME: laptop.base,
        T3_MESH_SSH_HOME: laptop.home,
      },
    });
  const execOutput = await replicaRun([
    "--",
    process.execPath,
    "-e",
    "process.stdout.write('bundle-exec')",
  ]);
  if (!execOutput.includes("bundle-exec")) throw Error("Bundled worker exec failed");
  const backgroundId = (
    await replicaRun(["--bg", "--", process.execPath, "-e", "setTimeout(() => {}, 5000)"])
  ).trim();
  if (!/^[a-f0-9-]{36}$/.test(backgroundId))
    throw Error(`Bundled worker start returned ${JSON.stringify(backgroundId)}`);
  await replicaRun(["--stop", backgroundId]);
  const kitStatus = await until(
    "bundled skill reconciliation",
    () => mcp(studio, "t3_mesh_status"),
    (value) =>
      nodes.every((node) =>
        value.servers
          .find((server) => server.environmentId === node.id)
          ?.actions.some(
            (action) =>
              action.id === "agents/kit" && (action.state === "done" || action.state === "failed"),
          ),
      ),
  );
  for (const node of nodes) {
    const action = kitStatus.servers
      .find((server) => server.environmentId === node.id)
      .actions.find((action) => action.id === "agents/kit");
    if (action.state !== "done") throw Error(node.name + ": " + action.reason);
    const expected = await NodeFSP.readFile(
      NodePath.resolve("agent-kit/skills/t3/SKILL.md"),
      "utf8",
    );
    if (
      (await NodeFSP.readFile(NodePath.join(node.home, ".agents/skills/t3/SKILL.md"), "utf8")) !==
      expected
    )
      throw Error("Installed skill differs from the bundled skill");
    for (const relative of [".claude/CLAUDE.md", ".codex/AGENTS.md", ".config/opencode/AGENTS.md"])
      if (
        !(await NodeFSP.readFile(NodePath.join(node.home, relative), "utf8")).includes(
          "<!-- t3-mesh begin -->",
        )
      )
        throw Error("Missing managed instruction block");
  }
  console.log(
    `PASS ${process.platform}/${process.arch}: two servers, mesh config, managed SSH, real replica and bundled worker exec/start`,
  );
} catch (error) {
  console.error(logs.join("").slice(-20000));
  throw error;
} finally {
  for (const node of nodes) {
    const mutagen = NodePath.join(node.base, "bin", windows ? "mutagen.exe" : "mutagen");
    try {
      await run(mutagen, ["daemon", "stop"], {
        env: { ...process.env, MUTAGEN_DATA_DIRECTORY: NodePath.join(node.base, "mutagen") },
      });
    } catch (error) {
      if (error.code !== "ENOENT") console.error("Mutagen cleanup:", error.message);
    }
  }
  for (const child of children) child.kill("SIGTERM");
  for (const service of sshServices)
    await powershell(
      `$ErrorActionPreference='Stop'; Stop-Service '${service}'; & sc.exe delete '${service}'; if($LASTEXITCODE -ne 0){throw 'Cannot remove fixture SSH service'}`,
    );
  console.log(`mesh platform fixture: ${root}`);
}
