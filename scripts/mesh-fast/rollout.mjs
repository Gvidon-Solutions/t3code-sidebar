import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import {
  installPublicRuntime,
  installSshRuntime,
} from "../../agent-kit/skills/t3/scripts/server-runtime.mjs";
import { MiniMesh } from "./mesh.mjs";
import { project, rpc, mcp, until, run, invariant } from "./helpers.mjs";
async function port() {
  const s = NodeNet.createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const value = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return value;
}
export const rolloutScenarios = {
  "bootstrap-rollout": async (directory) => {
    const releases = process.env.MESH_FAST_RUNTIMES;
    NodeAssert.ok(releases, "Native fixture releases must be prepared");
    const server = NodeHttp.createServer(async (request, response) => {
      if (request.headers.authorization) {
        response.writeHead(403).end();
        return;
      }
      if (request.url === "/repos/fixture/releases/latest") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            tag_name: "0.1.5",
            assets: [
              {
                name: "t3-0.1.5-linux-x64.tar.gz",
                browser_download_url: `http://127.0.0.1:${server.address().port}/v0.1.5/t3-0.1.5-linux-x64.tar.gz`,
              },
            ],
          }),
        );
        return;
      }
      const file = NodePath.resolve(
        releases,
        "." + new URL(request.url, "http://fixture").pathname,
      );
      if (
        !file.startsWith(releases + NodePath.sep) ||
        !/\/(SHA256SUMS|t3-[\w.+-]+\.tar\.gz)$/.test(file)
      ) {
        response.writeHead(404).end();
        return;
      }
      try {
        const bytes = await NodeFSP.readFile(file);
        response.writeHead(200, { "content-length": bytes.length }).end(bytes);
      } catch (error) {
        if (error.code !== "ENOENT") console.error(error);
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const releasePort = server.address().port;
    const sshPort = await port(),
      apiPort = await port();
    const mesh = Object.assign(new MiniMesh(directory), {
      launcher: true,
      environment: { T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${releasePort}` },
      extraRoutes: [releasePort, sshPort, apiPort],
    });
    let fresh;
    mesh.beforeClose.push(async () => {
      if (fresh) {
        const owned = fresh;
        fresh = undefined;
        await NodeFSP.writeFile(
          NodePath.join(directory, "fresh.log"),
          await run("docker", ["logs", owned]),
        );
        await run("docker", ["rm", "-f", owned]);
      }
      if (server.listening)
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    });
    try {
      await mesh.start(["studio", "laptop"]);
      const [studio, laptop] = mesh.nodes;
      fresh = "mesh-fast-bootstrap-" + process.pid + "-" + NodePath.basename(directory);
      const freshRoot = NodePath.join(directory, "fresh");
      await NodeFSP.mkdir(freshRoot);
      await run("docker", [
        "run",
        "-d",
        "--name",
        fresh,
        "--privileged",
        "--cgroupns=host",
        "--network",
        mesh.network,
        "--add-host",
        "host.docker.internal:" + mesh.gateway,
        "--tmpfs",
        "/run",
        "--tmpfs",
        "/tmp",
        "-v",
        "/sys/fs/cgroup:/sys/fs/cgroup:rw",
        "-v",
        freshRoot + ":" + freshRoot,
        "-p",
        `127.0.0.1:${sshPort}:22`,
        "-p",
        `127.0.0.1:${apiPort}:${apiPort}`,
        "mesh-fast-bootstrap:24",
      ]);
      await until(
        "fresh sshd and no T3/Node",
        () =>
          run("docker", [
            "exec",
            fresh,
            "sh",
            "-ec",
            "! command -v node; ! command -v t3; systemctl is-active ssh",
          ]),
        (value) => value.trim() === "active",
      );
      for (const target of [studio.front, laptop.front, releasePort])
        await run("docker", [
          "exec",
          "-d",
          fresh,
          "socat",
          `TCP-LISTEN:${target},bind=127.0.0.1,reuseaddr,fork`,
          `TCP:host.docker.internal:${target}`,
        ]);
      const identity = NodePath.join(studio.home, "bootstrap-key");
      await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity]);
      const publicKey = await NodeFSP.readFile(identity + ".pub", "utf8");
      await run("docker", [
        "exec",
        fresh,
        "sh",
        "-ec",
        "mkdir -p /root/.ssh; chmod 700 /root/.ssh; printf '%s' \"$1\" > /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys",
        "sh",
        publicKey,
      ]);
      await run("docker", [
        "exec",
        "-u",
        "node",
        studio.container,
        "ssh",
        "-i",
        identity,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "UserKnownHostsFile=" + NodePath.join(studio.home, "bootstrap-probe-hosts"),
        "-p",
        String(sshPort),
        "root@127.0.0.1",
        "true",
      ]);
      const p = await project(mesh, "bootstrap");
      const initial = await rpc(studio, "meshConfig.get");
      const machines = Object.fromEntries(
        mesh.nodes.map((node) => [
          node.name,
          initial.current.doc.machines[
            Object.keys(initial.bindings).find((key) => initial.bindings[key] === node.id)
          ],
        ]),
      );
      await rpc(studio, "meshConfig.apply", {
        baseRevision: initial.current.revision,
        doc: { ...initial.current.doc, machines },
      });
      const before = await rpc(studio, "meshConfig.get");
      const base = NodePath.join(freshRoot, "state");
      await rpc(studio, "meshConfig.apply", {
        baseRevision: before.current.revision,
        doc: {
          ...before.current.doc,
          t3: { version: "0.1.5" },
          machines: {
            ...before.current.doc.machines,
            cloudbox: {
              title: "cloudbox",
              label: "CB",
              bootstrap: { ssh: `root@127.0.0.1:${sshPort}`, port: apiPort, baseDir: base },
              reach: { address: `http://127.0.0.1:${apiPort}` },
              ssh: { user: "root", port: 22 },
            },
          },
          replicas: { rules: [{ project: p.title, on: "cloudbox", when: "always" }] },
        },
      });
      await mcp(studio, "t3_mesh_bootstrap_credential", {
        name: "cloudbox",
        kind: "key",
        identityFile: identity,
      });
      const joined = await until(
        "fresh bootstrap binding",
        () => rpc(studio, "meshConfig.get"),
        (value) => Boolean(value.bindings.cloudbox),
      );
      const rootNode = {
        name: "cloudbox",
        id: joined.bindings.cloudbox,
        origin: `http://127.0.0.1:${apiPort}`,
        containerOwnedRoot: true,
        base,
        home: freshRoot,
      };
      rootNode.cli = (args) =>
        run("docker", [
          "exec",
          fresh,
          NodePath.join(base, "runtime/versions/0.1.5/t3"),
          ...args,
          "--base-dir",
          base,
        ]);
      rootNode.token = (
        await rootNode.cli(["auth", "session", "issue", "--ttl", "1h", "--token-only"])
      ).split("\n")[0];
      await until(
        "bootstrap replica watching",
        () => mcp(studio, "t3_project_machines", { project: p.key }),
        (value) =>
          value.representations.some(
            (rep) => rep.environmentId === rootNode.id && rep.status?.state === "watching",
          ),
      );
      const placed = (
        await mcp(studio, "t3_project_machines", { project: p.key })
      ).representations.find((rep) => rep.environmentId === rootNode.id);
      NodeAssert.equal(
        await run("docker", ["exec", fresh, "cat", NodePath.join(placed.path, "README.md")]),
        p.title,
      );
      await mcp(studio, "t3_mesh_update", { version: "0.1.6" });
      await until(
        "second machine rolled back",
        () => NodeFSP.readFile(NodePath.join(laptop.base, "runtime/service-state.json"), "utf8"),
        (text) => {
          const state = JSON.parse(text);
          return state.activeVersion === "0.1.5" && state.update?.status === "rolled-back";
        },
      );
      const versions = await until(
        "rolled back API and updated peer ready",
        async () => {
          for (const node of [studio, laptop, rootNode]) {
            delete node.mcpInitialized;
            delete node.mcpSession;
          }
          return Promise.all(
            [studio, laptop, rootNode].map((node) => mcp(node, "t3_mesh_update_health")),
          );
        },
        (values) =>
          JSON.stringify(values.map((value) => value.version)) ===
          JSON.stringify(["0.1.5", "0.1.5", "0.1.6"]),
      );
      NodeAssert.deepEqual(
        versions.map((value) => value.version),
        ["0.1.5", "0.1.5", "0.1.6"],
      );
      NodeAssert.equal(
        JSON.parse(
          await NodeFSP.readFile(NodePath.join(studio.base, "runtime/service-state.json"), "utf8"),
        ).update,
        undefined,
      );
      for (const node of [laptop, rootNode]) {
        const files =
          node === rootNode
            ? await run("docker", [
                "exec",
                fresh,
                "find",
                NodePath.join(base, "runtime/mesh-backup"),
                "-name",
                "statev2.sqlite",
              ])
            : await NodeFSP.readdir(NodePath.join(node.base, "runtime/mesh-backup"));
        NodeAssert.ok(files.length);
      }
      const status = await until(
        "rollout failure published",
        () => mcp(studio, "t3_mesh_status"),
        (value) => JSON.stringify(value).includes("Injected mesh rollout health failure"),
      );
      const publicRuntime = await installPublicRuntime({
        home: NodePath.join(directory, "public-install"),
        repository: "fixture",
        want: "latest",
        api: `http://127.0.0.1:${releasePort}`,
      });
      NodeAssert.equal(
        (await run(NodePath.join(publicRuntime.path, "t3"), ["--version"])).trim(),
        "t3 v0.1.5",
      );
      const copiedRuntime = installSshRuntime({
        home: NodePath.join(directory, "ssh-install"),
        want: "0.1.5",
        destination: "t3-studio",
        remoteHome: studio.base,
        run: (command, args, options) =>
          NodeChildProcess.execFileSync(
            command,
            ["-F", NodePath.join(laptop.home, ".ssh/config"), ...args],
            options,
          ),
      });
      NodeAssert.equal(
        (await run(NodePath.join(copiedRuntime.path, "t3"), ["--version"])).trim(),
        "t3 v0.1.5",
      );
      await run("docker", ["cp", process.execPath, fresh + ":/usr/local/bin/node"]);
      const scripts = NodePath.join(freshRoot, "scripts");
      await NodeFSP.cp(new URL("../../agent-kit/skills/t3/scripts", import.meta.url), scripts, {
        recursive: true,
      });
      const cliBase = NodePath.join(freshRoot, "cli-state");
      await NodeFSP.mkdir(NodePath.join(cliBase, "runtime"), { recursive: true });
      await NodeFSP.symlink(
        NodePath.join(base, "runtime/versions"),
        NodePath.join(cliBase, "runtime/versions"),
      );
      const cliPort = await port(),
        unit = "mesh-fast-cli.service";
      await run("docker", [
        "exec",
        fresh,
        "sh",
        "-ec",
        'printf "%s" "$1" > /etc/systemd/system/mesh-fast-cli.service; systemctl daemon-reload; systemctl start mesh-fast-cli.service',
        "sh",
        `[Unit]\nDescription=Isolated runtime CLI\n[Service]\nEnvironment=T3CODE_HOME=${cliBase}\nExecStart=${cliBase}/runtime/versions/0.1.5/t3 serve --base-dir ${cliBase} --host 127.0.0.1 --port ${cliPort} --no-browser\n`,
      ]);
      const ctl = async (...args) =>
        run("docker", [
          "exec",
          "-e",
          "T3CODE_HOME=" + cliBase,
          "-e",
          "T3CTL_UNIT=" + unit,
          fresh,
          "node",
          NodePath.join(scripts, "t3ctl.mjs"),
          "server",
          ...args,
        ]);
      await until(
        "real CLI service ready",
        () => ctl("status"),
        (text) => text.includes("active (running)") && text.includes("runtime:"),
      );
      NodeAssert.ok(
        JSON.parse(await ctl("versions", "--json")).some(
          (row) => row.version === "0.1.5" && row.current,
        ),
      );
      await ctl("use", "0.1.6", "--yes");
      NodeAssert.ok(
        JSON.parse(await ctl("versions", "--json")).some(
          (row) => row.version === "0.1.6" && row.current,
        ),
      );
      await ctl("restart", "--yes");
      NodeAssert.match(await ctl("logs"), /T3|server|Server/);
      mesh.nodes.push(rootNode);
      await invariant(mesh);
      mesh.nodes.pop();
      await NodeFSP.writeFile(
        NodePath.join(directory, "rollout.json"),
        JSON.stringify({ versions: versions.map((value) => value.version), status }, null, 2),
      );
    } finally {
      await mesh.close();
    }
  },
};
