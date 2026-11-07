import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
export async function runScenarios(h) {
  const { nodes, root, runtime, mcp, rpc, file, remote, run, upload, until, quote } = h;
  const [studio, laptop, cloudbox] = nodes;
  let doc = h.doc;
  const cloud = (command) => remote("cloudbox", `docker exec R1-mesh-cloudbox ${command}`);
  const source = "/bed/R1-primary";
  await file(cloudbox, source + "/input.txt", "initial");
  await file(cloudbox, source + "/README.md", "R1 primary");
  const project =
    (await mcp(cloudbox, "t3_project_list", { limit: 100 })).projects.find(
      (project) => project.workspaceRoot === source,
    ) ??
    (await mcp(cloudbox, "t3_project_create", { title: "R1 Run primary", workspaceRoot: source }));
  await mcp(cloudbox, "t3_project_place", {
    project: project.id,
    machine: cloudbox.id,
    role: "primary",
    path: source,
  });
  const key = (await mcp(cloudbox, "t3_project_machines", { project: project.id })).logicalKey;
  const apply = async (next) => {
    const current = await mcp(studio, "t3_mesh_config_get");
    await mcp(studio, "t3_mesh_config_apply", {
      doc: next,
      baseRevision: current.current.revision,
    });
    doc = next;
  };
  await apply({
    ...doc,
    replicas: {
      rules: [studio, laptop].map((node) => ({
        project: "R1 Run primary",
        on: node.host,
        when: "always",
      })),
    },
  });
  for (const node of [studio, laptop]) {
    const ready = await until(
      `${node.name} R1 replica`,
      () => mcp(node, "t3_project_machines", { project: key }),
      (value) =>
        value.representations.some(
          (rep) => rep.environmentId === node.id && rep.status?.state === "watching",
        ),
    );
    node.replica = ready.representations.find((rep) => rep.environmentId === node.id);
    node.session = node.replica.live?.sessionName;
    NodeAssert.ok(node.session);
  }
  const replica = studio.replica.path;
  const mutate = (action) =>
    run(runtime + "/mutagen", ["sync", action, studio.session], {
      env: {
        ...process.env,
        HOME: studio.home,
        MUTAGEN_DATA_DIRECTORY: studio.base + "/mutagen",
        MUTAGEN_SSH_PATH: studio.base + "/mesh/ssh/bin",
      },
    });
  await cloud(`mkdir -p /bed/home/.nvm/versions/node/v26.12.1/bin /bed/home/.local/bin`);
  await upload(
    "cloudbox",
    NodePath.join(process.env.NVM_DIR || NodePath.join(NodeOS.homedir(), ".nvm"), "nvm.sh"),
    root + "/nvm.sh",
  );
  const uv = (await run("sh", ["-c", "command -v uv"])).trim();
  await upload("cloudbox", uv, root + "/uv");
  await cloud(
    `sh -ec ${quote("cp /bed/nvm.sh /bed/home/.nvm/nvm.sh; cp /bed/uv /bed/home/.local/bin/uv; chmod 755 /bed/home/.local/bin/uv; test -L /bed/home/.nvm/versions/node/v26.12.1/bin/node || ln -s /usr/local/bin/node /bed/home/.nvm/versions/node/v26.12.1/bin/node")}`,
  );
  const profile =
    'export HOME=/bed/home\nexport PATH=/usr/bin:/bin\nexport NVM_DIR=/bed/home/.nvm\n. "$NVM_DIR/nvm.sh" --no-use\nnvm use --silent v26.12.1\nexport PATH=/bed/home/.local/bin:$PATH\nexport R1_LOGIN_PROFILE=loaded\n';
  const loginHome = await cloud(`node -p ${quote("require('node:os').userInfo().homedir")}`);
  for (const home of new Set([cloudbox.home, loginHome])) {
    await file(cloudbox, `${home}/.bash_profile`, profile);
  }
  const env = {
    ...process.env,
    HOME: studio.home,
    T3CODE_HOME: studio.base,
    T3CODE_RUN_SSH_CONFIG: studio.home + "/.ssh/config",
  };
  const cli = studio.base + "/run/bin/t3";
  const launch = (args, cwd = replica, environment = env, executable = cli) => {
    const child = NodeChildProcess.spawn(executable, ["run", ...args], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "",
      stderr = "";
    const waiters = new Set();
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const waiter of waiters)
        if (stdout.includes(waiter.text)) {
          waiters.delete(waiter);
          waiter.resolve();
        }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const result = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        for (const waiter of waiters)
          waiter.reject(Error(`Exited before ${waiter.text}: ${stderr}`));
        resolve({ code, stdout, stderr });
      });
    });
    return {
      child,
      result,
      ready: (text) =>
        stdout.includes(text)
          ? Promise.resolve()
          : new Promise((resolve, reject) => waiters.add({ text, resolve, reject })),
    };
  };
  const execute = async (name, args, cwd) => {
    const result = await launch(args, cwd).result;
    console.log(name, JSON.stringify(result));
    return result;
  };
  const login = await execute("login_nvm_uv", [
    "--",
    "node",
    "-e",
    "console.log(process.env.R1_LOGIN_PROFILE);console.log(process.version);console.log(require('child_process').execFileSync('uv',['--version']).toString().trim())",
  ]);
  NodeAssert.equal(login.code, 0);
  NodeAssert.match(login.stdout, /loaded\nv26\.12\.1\nuv /);
  await NodeFSP.mkdir(replica + "/nested", { recursive: true });
  const mapped = await execute(
    "mapped_live_stream_exit",
    [
      "--",
      "node",
      "-e",
      "process.stdout.write(process.cwd()+'\\n');process.stderr.write(process.cwd()+'/error\\n');process.exitCode=23",
    ],
    replica + "/nested",
  );
  NodeAssert.deepEqual(mapped, {
    code: 23,
    stdout: replica + "/nested\n",
    stderr: replica + "/nested/error\n",
  });
  const ignored = await execute("ignored_outputs", [
    "--",
    "node",
    "-e",
    "const fs=require('fs');fs.writeFileSync('returned.txt','back');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/result.txt','stays')",
  ]);
  NodeAssert.equal(ignored.code, 0);
  NodeAssert.equal(ignored.stderr, `dist/result.txt stayed on ${cloudbox.host}\n`);
  NodeAssert.equal(await NodeFSP.readFile(replica + "/returned.txt", "utf8"), "back");
  await NodeAssert.rejects(NodeFSP.access(replica + "/dist/result.txt"));
  const concurrent = await Promise.all([
    execute("concurrent_one", ["--", "node", "-e", "console.log('one')"]),
    execute("concurrent_two", ["--", "node", "-e", "console.log('two')"]),
  ]);
  NodeAssert.ok(concurrent.every((value) => value.code === 0));
  let conflictCopy = "";
  await remote("laptop", "systemctl --user stop R1-mesh-laptop.service");
  try {
    await run("systemctl", ["--user", "restart", "R1-mesh-studio.service"]);
    studio.mcpInitialized = false;
    delete studio.mcpSession;
    await until(
      "fresh conflict driver",
      () => execute("conflict_driver_ready", ["--", "node", "-e", "console.log('ready')"]),
      (value) => value.code === 0,
    );
    await cloud(
      `node -e ${quote("require('fs').rmSync('/bed/R1-primary/must-not-run',{force:true})")}`,
    );
    await mutate("pause");
    await file(cloudbox, source + "/input.txt", "primary conflict");
    await NodeFSP.writeFile(replica + "/input.txt", "replica conflict");
    await mutate("resume");
    const conflict = await execute("conflict_before_run", [
      "--",
      "node",
      "-e",
      "const fs=require('fs');fs.writeFileSync('must-not-run',fs.readFileSync('input.txt'))",
    ]);
    if (conflict.code === 75) {
      NodeAssert.match(conflict.stderr, /input.txt|Replica synchronization failed/);
      await NodeAssert.rejects(cloud(`test -f ${source}/must-not-run`));
    } else {
      // The automatic primary-wins resolver can finish before run preparation inspects conflicts.
      NodeAssert.equal(conflict.code, 0);
      NodeAssert.equal(await cloud(`cat ${source}/must-not-run`), "primary conflict");
    }
    conflictCopy = await until(
      "automatic primary-wins conflict preservation",
      async () => {
        if ((await NodeFSP.readFile(replica + "/input.txt", "utf8")) !== "primary conflict") return;
        const directory = replica + "/.t3-conflicts";
        const entries = await NodeFSP.readdir(directory, {
          recursive: true,
          withFileTypes: true,
        }).catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        for (const entry of entries) {
          if (!entry.isFile() || entry.name !== "input.txt") continue;
          const path = NodePath.join(entry.parentPath, entry.name);
          if ((await NodeFSP.readFile(path, "utf8")) === "replica conflict") return path;
        }
      },
      (value) => typeof value === "string",
    );
    console.log(
      "PASS R1 automatic conflict resolution preserved the real losing version",
      conflictCopy,
    );
  } finally {
    await remote("laptop", "systemctl --user start R1-mesh-laptop.service");
    laptop.mcpInitialized = false;
    delete laptop.mcpSession;
  }
  const portServer = NodeNet.createServer();
  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const serverCode = `require('net').createServer(s=>s.end('port-ok')).listen(${port},'127.0.0.1',()=>console.log('SERVER_READY'))`;
  const started = await execute("background_start", [
    "--bg",
    "--ports",
    String(port),
    "--",
    "node",
    "-e",
    serverCode,
  ]);
  NodeAssert.equal(started.code, 0);
  const id = started.stdout.trim();
  NodeAssert.match(id, /^[a-f0-9-]{36}$/);
  const following = launch(["--logs", id, "--follow"]);
  await following.ready("SERVER_READY");
  const listing = await execute("background_list", ["--list"]);
  NodeAssert.match(listing.stdout, new RegExp(id + "\\trunning"));
  const response = await new Promise((resolve, reject) => {
    let data = "";
    const socket = NodeNet.connect(port, "127.0.0.1");
    socket.on("error", reject);
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => resolve(data));
  });
  NodeAssert.equal(response, "port-ok");
  console.log("background_loopback_forward", JSON.stringify(response));
  NodeAssert.equal((await execute("background_stop", ["--stop", id])).code, 0);
  const followed = await following.result;
  NodeAssert.equal(followed.code, 143);
  console.log("background_follow", JSON.stringify(followed));
  await NodeAssert.rejects(
    new Promise((resolve, reject) => {
      const socket = NodeNet.connect(port, "127.0.0.1");
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.end();
        resolve();
      });
    }),
  );
  console.log("forward_released", true);
  const childCode = `require('net').createServer(()=>{}).listen(${port},'127.0.0.1',()=>console.log('TREE_READY'));setInterval(()=>{},1000)`;
  const parentCode = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;
  const groupGone = () =>
    cloud(
      `node -e ${quote(`const s=require('net').connect(${port},'127.0.0.1');s.once('connect',()=>{s.destroy();process.exitCode=1});s.once('error',e=>{if(e.code!=='ECONNREFUSED')throw e})`)}`,
    );
  const interrupted = launch(["--", "node", "-e", parentCode]);
  await interrupted.ready("TREE_READY");
  interrupted.child.kill("SIGINT");
  const interrupt = await interrupted.result;
  console.log("ctrl_c_group", JSON.stringify(interrupt));
  NodeAssert.equal(interrupt.code, 130);
  await groupGone();
  const managedConfig = await NodeFSP.readFile(studio.home + "/.ssh/config", "utf8");
  const block = managedConfig
    .split(/(?=^Host )/m)
    .find((block) => block.startsWith(`Host t3-${cloudbox.host}\n`));
  NodeAssert.ok(block);
  const proxyLine = block.split("\n").find((line) => line.trimStart().startsWith("ProxyCommand "));
  NodeAssert.ok(proxyLine);
  const proxyPid = root + "/cut-proxy.pid";
  const proxy = root + "/cut-proxy.sh";
  await NodeFSP.writeFile(
    proxy,
    `#!/bin/sh\nprintf '%s' "$$" > ${quote(proxyPid)}\nexec ${proxyLine.trim().slice("ProxyCommand ".length)}\n`,
    { mode: 0o700 },
  );
  const cutConfig = root + "/cut-ssh-config";
  await NodeFSP.writeFile(
    cutConfig,
    managedConfig.replace(block, block.replace(proxyLine, `  ProxyCommand ${quote(proxy)}`)),
    { mode: 0o600 },
  );
  const cut = launch(
    ["--", "node", "-e", parentCode],
    replica,
    { ...env, T3CODE_RUN_SSH_CONFIG: cutConfig },
    runtime + "/t3",
  );
  await cut.ready("TREE_READY");
  const pipePid = Number(await NodeFSP.readFile(proxyPid, "utf8"));
  NodeAssert.ok(Number.isSafeInteger(pipePid) && pipePid > 0);
  process.kill(pipePid, "SIGTERM");
  const severed = await cut.result;
  console.log("network_cut_mid_command", JSON.stringify(severed));
  NodeAssert.equal(severed.code, 255);
  NodeAssert.match(severed.stderr, /Cannot run on /);
  NodeAssert.equal(severed.stderr.trim().split("\n").length, 1);
  await groupGone();
  await remote("cloudbox", "docker pause R1-mesh-cloudbox");
  try {
    const offline = await execute("primary_offline", [
      "--",
      "node",
      "-e",
      "console.log('must-not-run')",
    ]);
    NodeAssert.equal(offline.code, 255);
    NodeAssert.equal(offline.stdout, "");
    NodeAssert.equal(offline.stderr.trim().split("\n").length, 1);
  } finally {
    await remote("cloudbox", "docker unpause R1-mesh-cloudbox");
  }
  await until(
    "primary recovery",
    () => execute("recovery_probe", ["--", "node", "-e", "console.log('recovered')"]),
    (value) => value.code === 0,
  );
  const canonical = (value) =>
    JSON.stringify(value, (_, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
        : v,
    );
  await until(
    "identical project layouts",
    () => Promise.all(nodes.map((node) => rpc(node, "meshLayout.get"))),
    (values) =>
      new Set(
        values.map((value) =>
          canonical({
            mounts: value.config.projectMounts,
            titles: value.config.projectTitles,
            workspaces: value.config.projectWorkspaces,
          }),
        ),
      ).size === 1,
  );
  for (const node of [studio, laptop]) {
    const status = await until(
      "final watching",
      () => mcp(node, "t3_project_machines", { project: key }),
      (value) =>
        value.representations.find((rep) => rep.environmentId === node.id)?.status?.state ===
        "watching",
    );
    NodeAssert.equal(status.representations.length, 3);
  }
  const sessions = JSON.parse(
    await run(runtime + "/mutagen", ["sync", "list", "--template", "{{json .}}"], {
      env: { ...env, MUTAGEN_DATA_DIRECTORY: studio.base + "/mutagen" },
    }),
  );
  NodeAssert.equal(sessions.length, 1);
  NodeAssert.equal(sessions[0].name, studio.session);
  NodeAssert.equal(await NodeFSP.readFile(conflictCopy, "utf8"), "replica conflict");
  console.log(
    "PASS R1 CONCEPT §12: real three-node bed; login nvm/uv, live mapping, ignored outputs, concurrency, safe conflict preparation, background forwards, Ctrl-C, connection loss and offline primary; identical layouts and one session per replica; losing version preserved",
  );
}
