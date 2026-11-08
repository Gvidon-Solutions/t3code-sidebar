import * as NodeFS from "node:fs";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import { fixture, project, place, content, mutagen, archive, until, rpc } from "./helpers.mjs";
import { ssh } from "./network.mjs";
import { allocatePort as port } from "./mesh.mjs";
import { productRoot } from "./paths.mjs";
function launch(node, cwd, args, extra = {}) {
  const direct = Boolean(extra.T3CODE_RUN_SSH_CONFIG);
  const child = NodeChildProcess.spawn(
    direct ? process.execPath : NodePath.join(node.base, "run/bin/t3"),
    [...(direct ? [NodePath.join(productRoot, "apps/server/src/bin.ts")] : []), "run", ...args],
    {
      cwd,
      env: { ...node.env, T3CODE_HOME: node.base, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const transcript = NodePath.join(node.root, "run.log");
  NodeFS.appendFileSync(transcript, JSON.stringify({ pid: child.pid, args }) + "\n");
  let stdout = "",
    stderr = "";
  const waiters = [];
  child.stdout.on("data", (bytes) => {
    stdout += bytes;
    NodeFS.appendFileSync(transcript, "stdout " + bytes);
    for (const entry of waiters) if (stdout.includes(entry.text)) entry.resolve();
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
    NodeFS.appendFileSync(transcript, "stderr " + bytes);
  });
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      for (const entry of waiters)
        if (!stdout.includes(entry.text))
          entry.reject(Error("Exited before " + entry.text + ": " + stderr));
      NodeFS.appendFileSync(transcript, "exit " + code + "\n");
      resolve({ code, stdout, stderr });
    });
  });
  return {
    child,
    result,
    ready: (text) =>
      stdout.includes(text)
        ? Promise.resolve()
        : new Promise((resolve, reject) => waiters.push({ text, resolve, reject })),
  };
}
export const runScenarios = {
  "run-concept": (directory) =>
    fixture(directory, async (mesh) => {
      const [studio, , laptop] = mesh.nodes,
        p = await project(mesh, "run"),
        rep = await place(laptop, p);
      const execute = (args) => launch(laptop, rep.path, args).result;
      const sourceName = Object.entries((await rpc(laptop, "meshConfig.get")).bindings).find(
        ([, id]) => id === studio.id,
      )[0];
      const fast = process.env.MESH_FAST_REALISTIC !== "1";
      const writeConfig = async (file, text) => {
        await NodeFSP.writeFile(file + ".next", text, { mode: 0o600 });
        await NodeFSP.rename(file + ".next", file);
      };
      const prime = async (file, control) => {
        if (!fast) return undefined;
        const prefix =
          "Host *\n  ControlMaster auto\n  ControlPath " +
          JSON.stringify(control) +
          "\n  ControlPersist no\n";
        await writeConfig(file, prefix + (await NodeFSP.readFile(file, "utf8")));
        const child = mesh.launch(
          "ssh",
          ["-F", file, "-o", "ConnectTimeout=30", "-M", "-N", "t3-" + sourceName],
          laptop.env,
          NodePath.join(laptop.root, "ssh-masters.log"),
        );
        const closed = mesh.children.find((entry) => entry.child === child).closed;
        await until(
          "real managed SSH control connection",
          () => NodeFSP.stat(control),
          (value) => value.isSocket(),
        );
        return { child, closed, file, prefix };
      };
      const release = async (master) => {
        if (!master) return;
        if (master.child.exitCode === null && master.child.signalCode === null)
          master.child.kill("SIGTERM");
        await master.closed;
        await writeConfig(
          master.file,
          (await NodeFSP.readFile(master.file, "utf8")).replace(master.prefix, ""),
        );
      };
      const master = await prime(
        NodePath.join(laptop.home, ".ssh/config"),
        NodePath.join(laptop.home, "run-control"),
      );
      await NodeFSP.mkdir(NodePath.join(studio.home, ".nvm/versions/node/fixture/bin"), {
        recursive: true,
      });
      await NodeFSP.symlink(
        "/usr/local/bin/node",
        NodePath.join(studio.home, ".nvm/versions/node/fixture/bin/node"),
      );
      await NodeFSP.mkdir(NodePath.join(studio.home, ".local/bin"), { recursive: true });
      await NodeFSP.symlink("/usr/local/bin/uv", NodePath.join(studio.home, ".local/bin/uv"));
      await NodeFSP.writeFile(
        NodePath.join(studio.home, ".bash_profile"),
        'export PATH=/usr/bin:/bin\nexport NVM_DIR="$HOME/.nvm"\n. /opt/nvm.sh --no-use\nnvm use --silent fixture\nexport PATH="$HOME/.local/bin:$PATH"\nexport FAST_LOGIN=loaded\n',
      );
      const login = await execute([
        "--",
        "node",
        "-e",
        "console.log(process.env.FAST_LOGIN);console.log(process.version);console.log(require('child_process').execFileSync('uv',['--version']).toString())",
      ]);
      NodeAssert.equal(login.code, 0, login.stderr);
      NodeAssert.match(login.stdout, /loaded\nv26\.12\.1\nuv /);
      await NodeFSP.mkdir(NodePath.join(rep.path, "nested"));
      const mapped = await launch(laptop, NodePath.join(rep.path, "nested"), [
        "--",
        "node",
        "-e",
        "console.log(process.cwd());console.error(process.cwd()+'/err');process.exitCode=23",
      ]).result;
      NodeAssert.deepEqual(mapped, {
        code: 23,
        stdout: rep.path + "/nested\n",
        stderr: rep.path + "/nested/err\n",
      });
      const ignored = await execute([
        "--",
        "node",
        "-e",
        "const fs=require('fs');fs.writeFileSync('returned.txt','returned');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/output.txt','stays')",
      ]);
      NodeAssert.equal(ignored.code, 0, ignored.stderr);
      NodeAssert.match(ignored.stderr, /dist\/output.txt stayed on/);
      await content(NodePath.join(rep.path, "returned.txt"), "returned");
      await NodeAssert.rejects(NodeFSP.stat(NodePath.join(rep.path, "dist/output.txt")), {
        code: "ENOENT",
      });
      const concurrent = await Promise.all(
        ["one", "two"].map((word) => execute(["--", "node", "-e", `console.log('${word}')`])),
      );
      NodeAssert.ok(concurrent.every((value) => value.code === 0));
      NodeAssert.deepEqual(
        concurrent.map((value) => value.stdout.trim()),
        ["one", "two"],
      );
      const guard = NodeChildProcess.spawn(
        NodePath.join(laptop.base, "run/shims/git"),
        ["status"],
        {
          cwd: rep.path,
          env: { ...laptop.env, T3CODE_HOME: laptop.base },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let diagnostic = "";
      guard.stderr.on("data", (data) => (diagnostic += data));
      const guardCode = await new Promise((resolve, reject) => {
        guard.on("close", resolve);
        guard.on("error", reject);
      });
      NodeAssert.equal(guardCode, 127);
      NodeAssert.match(diagnostic, /t3 run/);
      await mutagen(laptop, "sync", "pause", rep.session);
      await NodeFSP.writeFile(NodePath.join(p.root, "README.md"), "primary conflict");
      await NodeFSP.writeFile(NodePath.join(rep.path, "README.md"), "replica conflict");
      await mutagen(laptop, "sync", "resume", rep.session);
      const conflict = await execute([
        "--",
        "node",
        "-e",
        "require('fs').writeFileSync('must-not-run',require('fs').readFileSync('README.md'))",
      ]);
      if (conflict.code === 75) {
        await NodeAssert.rejects(NodeFSP.stat(NodePath.join(p.root, "must-not-run")), {
          code: "ENOENT",
        });
      } else {
        NodeAssert.equal(conflict.code, 0, conflict.stderr);
        await content(NodePath.join(p.root, "must-not-run"), "primary conflict");
      }
      await content(NodePath.join(rep.path, "README.md"), "primary conflict");
      await archive(rep.path, "replica conflict");
      const number = await port(),
        code = `require('net').createServer(s=>s.end('port-ok')).listen(${number},'127.0.0.1',()=>console.log('SERVER_READY'))`;
      const bg = await execute(["--bg", "--ports", String(number), "--", "node", "-e", code]);
      NodeAssert.equal(bg.code, 0, bg.stderr);
      const id = bg.stdout.trim();
      NodeAssert.match(id, /^[a-f0-9-]{36}$/);
      const follow = launch(laptop, rep.path, ["--logs", id, "--follow"]);
      await follow.ready("SERVER_READY");
      NodeAssert.match((await execute(["--list"])).stdout, new RegExp(id + "\\trunning"));
      const response = await new Promise((resolve, reject) => {
        let value = "";
        const socket = NodeNet.connect(number, "127.0.0.1");
        socket.on("error", reject);
        socket.on("data", (bytes) => (value += bytes));
        socket.on("end", () => resolve(value));
      });
      NodeAssert.equal(response, "port-ok");
      NodeAssert.equal((await execute(["--stop", id])).code, 0);
      NodeAssert.equal((await follow.result).code, 143);
      const childCode = `require('net').createServer(()=>{}).listen(${number},'127.0.0.1',()=>console.log('TREE_READY'));setInterval(()=>{},1000)`;
      const parentCode = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;
      const gone = () =>
        ssh(
          laptop,
          studio,
          `node -e ${JSON.stringify(`const s=require('net').connect(${number},'127.0.0.1');s.on('connect',()=>{s.destroy();process.exitCode=1});s.on('error',e=>{if(e.code!=='ECONNREFUSED')throw e;})`)}`,
        );
      const interrupted = launch(laptop, rep.path, ["--", "node", "-e", parentCode]);
      await interrupted.ready("TREE_READY");
      interrupted.child.kill("SIGINT");
      NodeAssert.equal((await interrupted.result).code, 130);
      await gone();
      await release(master);
      const managed = await NodeFSP.readFile(NodePath.join(laptop.home, ".ssh/config"), "utf8");
      const block = managed
          .split(/(?=^Host )/m)
          .find((value) => value.startsWith("Host t3-" + sourceName + "\n")),
        line = block.split("\n").find((value) => value.trimStart().startsWith("ProxyCommand "));
      const script = NodePath.join(laptop.home, "cut-proxy.sh"),
        pidFile = NodePath.join(laptop.home, "cut-proxy.pid");
      await NodeFSP.writeFile(
        script,
        `#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\nexec ${line.trim().slice(13)}\n`,
        { mode: 0o700 },
      );
      const alternative = NodePath.join(laptop.home, "cut-config");
      await NodeFSP.writeFile(
        alternative,
        managed.replace(block, block.replace(line, "  ProxyCommand " + script)),
      );
      const cutMaster = await prime(alternative, NodePath.join(laptop.home, "cut-control"));
      const cut = launch(laptop, rep.path, ["--", "node", "-e", parentCode], {
        T3CODE_RUN_SSH_CONFIG: alternative,
      });
      await cut.ready("TREE_READY");
      const pid = Number(await NodeFSP.readFile(pidFile, "utf8"));
      NodeAssert.ok(Number.isSafeInteger(pid) && pid > 1);
      process.kill(pid, "SIGTERM");
      const result = await cut.result;
      NodeAssert.equal(result.code, 255, result.stderr);
      await release(cutMaster);
      await gone();
      await mesh.signal(studio, "SIGSTOP");
      try {
        await until(
          "primary offline",
          () => rpc(laptop, "meshLayout.status"),
          (value) =>
            value.connections.some(
              (row) => row.environmentId === studio.id && row.state === "offline",
            ),
        );
        const offline = await execute([
          "--timeout",
          "3s",
          "--",
          "node",
          "-e",
          "console.log('must-not-run')",
        ]);
        NodeAssert.equal(offline.code, 255, offline.stderr);
        NodeAssert.equal(offline.stdout, "");
      } finally {
        await mesh.signal(studio, "SIGCONT");
      }
      await until(
        "run recovery",
        () => execute(["--", "node", "-e", "console.log('recovered')"]),
        (value) => value.code === 0,
      );
    }),
};
