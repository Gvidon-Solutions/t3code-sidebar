import * as NodeFS from "node:fs";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeEvents from "node:events";
import { productRoot } from "./paths.mjs";
const { installPublicRuntime, installSshRuntime } = await import(
  NodeURL.pathToFileURL(
    NodePath.join(productRoot, "agent-kit/skills/t3/scripts/server-runtime.mjs"),
  ).href
);
import { MiniMesh, allocatePort as port } from "./mesh.mjs";
import { containerBoot } from "./boot.mjs";
import { project, rpc, mcp, until, run, invariant } from "./helpers.mjs";
export const rolloutScenarios = {
  "bootstrap-rollout": async (directory) => {
    const realistic = process.env.MESH_FAST_REALISTIC === "1";
    const mutagenArchive = realistic
      ? undefined
      : await NodeFSP.readFile(
          NodePath.join(process.env.MESH_FAST_MUTAGEN_CACHE, "mutagen.tar.gz"),
        );
    let mutagenDownloads = 0;
    const releases = process.env.MESH_FAST_RUNTIMES;
    NodeAssert.ok(releases, "Native fixture releases must be prepared");
    const certificate = NodePath.join(directory, "studio/home/bootstrap-ca.pem");
    const privateKey = NodePath.join(directory, "bootstrap-ca.key");
    await NodeFSP.mkdir(NodePath.dirname(certificate), { recursive: true });
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=mesh-fast",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      privateKey,
      "-out",
      certificate,
    ]);
    const handler = async (request, response) => {
      if (request.headers.authorization) {
        response.writeHead(403).end();
        return;
      }
      if (
        mutagenArchive &&
        request.method === "GET" &&
        request.url ===
          "/mutagen-io/mutagen/releases/download/v0.18.1/mutagen_linux_amd64_v0.18.1.tar.gz"
      ) {
        mutagenDownloads++;
        response.writeHead(200, { "content-length": mutagenArchive.length }).end(mutagenArchive);
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
    };
    const server = NodeHttp.createServer(handler);
    const secure = NodeHttps.createServer(
      { key: await NodeFSP.readFile(privateKey), cert: await NodeFSP.readFile(certificate) },
      handler,
    );
    const releasePort = await port(),
      secureReleasePort = await port(),
      secureApiPort = await port();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(releasePort, "127.0.0.1", resolve);
    });
    await new Promise((resolve, reject) => {
      secure.once("error", reject);
      secure.listen(secureReleasePort, "127.0.0.1", resolve);
    });
    const sshPort = await port(),
      apiPort = await port();
    const upgradedSockets = new Set();
    const api = NodeHttps.createServer(
      { key: await NodeFSP.readFile(privateKey), cert: await NodeFSP.readFile(certificate) },
      (request, response) => {
        response.once("finish", () =>
          NodeFS.appendFileSync(
            NodePath.join(directory, "bootstrap-http.jsonl"),
            JSON.stringify({
              method: request.method,
              path: new URL(request.url, "https://fixture").pathname,
              status: response.statusCode,
            }) + "\n",
          ),
        );
        const upstream = NodeHttp.request(
          {
            hostname: "127.0.0.1",
            port: apiPort,
            method: request.method,
            path: request.url,
            headers: {
              ...request.headers,
              "x-forwarded-proto": "https",
              "x-forwarded-host": request.headers.host,
            },
          },
          (incoming) => {
            response.writeHead(incoming.statusCode, incoming.headers);
            incoming.pipe(response);
          },
        );
        upstream.once("error", (error) => response.writeHead(502).end(error.message));
        request.pipe(upstream);
      },
    );
    api.on("upgrade", (request, socket, head) => {
      const outgoing = NodeHttp.request({
        hostname: "127.0.0.1",
        port: apiPort,
        path: request.url,
        headers: {
          ...request.headers,
          "x-forwarded-proto": "https",
          "x-forwarded-host": request.headers.host,
        },
      });
      outgoing.on("upgrade", (response, remote, remoteHead) => {
        NodeFS.appendFileSync(
          NodePath.join(directory, "bootstrap-http.jsonl"),
          JSON.stringify({ path: "/peer", status: response.statusCode }) + "\n",
        );
        upgradedSockets.add(socket);
        upgradedSockets.add(remote);
        socket.write(
          `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${response.rawHeaders.reduce((lines, value, index, values) => (index % 2 === 0 ? [...lines, value + ": " + values[index + 1]] : lines), []).join("\r\n")}\r\n\r\n`,
        );
        if (head.length) remote.write(head);
        if (remoteHead.length) socket.write(remoteHead);
        socket.once("close", () => {
          upgradedSockets.delete(socket);
          remote.destroy();
        });
        remote.once("close", () => {
          upgradedSockets.delete(remote);
          socket.destroy();
        });
        socket.on("error", (error) => remote.destroy(error));
        remote.on("error", () => socket.destroy());
        socket.pipe(remote);
        remote.pipe(socket);
      });
      outgoing.on("response", (response) => {
        socket.end(`HTTP/1.1 ${response.statusCode} Upgrade refused\r\nConnection: close\r\n\r\n`);
        response.resume();
      });
      outgoing.on("error", (error) => {
        NodeFS.appendFileSync(
          NodePath.join(directory, "bootstrap-http.jsonl"),
          JSON.stringify({ upgradeError: error.message }) + "\n",
        );
        socket.destroy();
      });
      outgoing.end();
    });
    api.on("tlsClientError", (error) =>
      NodeFS.appendFileSync(
        NodePath.join(directory, "bootstrap-http.jsonl"),
        JSON.stringify({ tlsError: error.message }) + "\n",
      ),
    );
    await new Promise((resolve, reject) => {
      api.once("error", reject);
      api.listen(secureApiPort, "127.0.0.1", resolve);
    });
    const mesh = Object.assign(new MiniMesh(directory), {
      launcher: true,
      timeScale: 0.2,
      environment: {
        T3CODE_RELEASE_BASE_URL: `https://127.0.0.1:${secureReleasePort}`,
        NODE_EXTRA_CA_CERTS: certificate,
      },
      extraRoutes: [releasePort, secureReleasePort, sshPort, apiPort, secureApiPort],
    });
    let fresh;
    const freshRoot = NodePath.join(directory, "fresh");
    mesh.beforeClose.push(async () => {
      if (fresh) {
        const owned = fresh;
        fresh = undefined;
        await NodeFSP.writeFile(
          NodePath.join(directory, "fresh-server.log"),
          await run("docker", ["exec", owned, "journalctl", "--no-pager", "-u", "t3-mesh.service"]),
        );
        await run("docker", ["stop", "--time", "1", owned]);
        await NodeFSP.writeFile(
          NodePath.join(directory, "fresh.log"),
          await run("docker", ["logs", owned]),
        );
        await run("docker", [
          "run",
          "--rm",
          "--network",
          "none",
          "--user",
          "0",
          "-v",
          freshRoot + ":/fixture",
          "mesh-fast-node:26",
          "chown",
          "-R",
          process.getuid() + ":" + process.getgid(),
          "/fixture",
        ]);
        await run("docker", ["rm", "-f", owned]);
      }
      for (const socket of upgradedSockets) socket.destroy();
      for (const endpoint of [secure, api])
        if (endpoint.listening)
          await new Promise((resolve, reject) =>
            endpoint.close((error) => (error ? reject(error) : resolve())),
          );
      if (server.listening)
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    });
    try {
      await mesh.start(["studio", "laptop"]);
      const [studio, laptop] = mesh.nodes;
      fresh = "mesh-fast-bootstrap-" + process.pid + "-" + NodePath.basename(directory);
      await NodeFSP.mkdir(freshRoot);
      await NodeFSP.writeFile(NodePath.join(freshRoot, ".mesh-fast-node"), "bootstrap fixture\n");
      await containerBoot(async () => {
        const freshCreate = mesh.launchContainer(
          [
            "run",
            "-d",
            "--name",
            fresh,
            "--privileged",
            "--cgroupns=private",
            "--network",
            mesh.network,
            "--add-host",
            "host.docker.internal:" + mesh.gateway,
            "--tmpfs",
            "/run",
            "--tmpfs",
            "/tmp",
            "-v",
            freshRoot + ":" + freshRoot,
            "-p",
            `127.0.0.1:${sshPort}:22`,
            "-p",
            `127.0.0.1:${apiPort}:${apiPort}`,
            "mesh-fast-bootstrap:24",
          ],
          process.env,
          NodePath.join(directory, "fresh-create.log"),
        );
        const [freshCode] = await NodeEvents.once(freshCreate, "close");
        if (freshCode !== 0) throw Error("Fresh fixture container exited " + freshCode);
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
      });
      const freshCertificate = NodePath.join(freshRoot, "bootstrap-ca.pem");
      await NodeFSP.copyFile(certificate, freshCertificate);
      const fixtureEnvironment = [
        "NODE_EXTRA_CA_CERTS=" + freshCertificate,
        "GOMAXPROCS=2",
        ...(!realistic
          ? [
              "NODE_ENV=test",
              "T3_MESH_TIME_SCALE=" + studio.env.T3_MESH_TIME_SCALE,
              `T3_MESH_TEST_ASSET_ORIGIN=http://127.0.0.1:${releasePort}`,
            ]
          : []),
      ];
      await run("docker", [
        "exec",
        fresh,
        "sh",
        "-ec",
        'mkdir -p /etc/systemd/system/t3-mesh.service.d; printf "%s" "$1" > /etc/systemd/system/t3-mesh.service.d/fixture.conf',
        "sh",
        "[Service]\n" + fixtureEnvironment.map((value) => "Environment=" + value).join("\n") + "\n",
      ]);
      for (const target of [
        studio.front,
        laptop.front,
        releasePort,
        secureReleasePort,
        secureApiPort,
      ])
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
      const hostKey = (
        await run("docker", ["exec", fresh, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"])
      )
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .join(" ");
      await NodeFSP.writeFile(
        NodePath.join(studio.home, "bootstrap-probe-hosts"),
        `[127.0.0.1]:${sshPort} ${hostKey}\n`,
      );
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
        "StrictHostKeyChecking=yes",
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
          t3: {
            version: "0.1.5",
            runtimeChecksums: Object.fromEntries(
              await Promise.all(
                ["0.1.5", "0.1.6"].map(async (version) => [
                  `t3-${version}-linux-x64.tar.gz`,
                  NodeCrypto.createHash("sha256")
                    .update(
                      await NodeFSP.readFile(
                        NodePath.join(releases, "v" + version, `t3-${version}-linux-x64.tar.gz`),
                      ),
                    )
                    .digest("hex"),
                ]),
              ),
            ),
          },
          machines: {
            ...before.current.doc.machines,
            cloudbox: {
              title: "cloudbox",
              label: "CB",
              bootstrap: {
                ssh: `root@127.0.0.1:${sshPort}`,
                port: apiPort,
                baseDir: base,
                hostKey,
                listenHost: "0.0.0.0",
              },
              reach: { address: `https://127.0.0.1:${secureApiPort}` },
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
      if (!realistic) {
        NodeAssert.ok(
          mutagenDownloads > 0,
          "Bootstrapped server must download the real pinned Mutagen archive from its private mirror",
        );
        const pid = await run("docker", [
          "exec",
          fresh,
          "systemctl",
          "show",
          "--property=MainPID",
          "--value",
          "t3-mesh.service",
        ]);
        const environment = (
          await run("docker", ["exec", fresh, "cat", `/proc/${pid}/environ`])
        ).split("\0");
        for (const value of fixtureEnvironment) NodeAssert.ok(environment.includes(value), value);
        await NodeFSP.writeFile(
          NodePath.join(directory, "bootstrap-fixture.json"),
          JSON.stringify({ mutagenDownloads, environment: fixtureEnvironment }),
        );
      }
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
      for (const name of ["public-install", "ssh-install"]) {
        const home = NodePath.join(directory, name);
        await NodeFSP.mkdir(home, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(home, ".mesh-fast-node"),
          "runtime installer fixture\n",
        );
      }
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
