import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import { allocatePort } from "./mesh.mjs";
import {
  fixture,
  project,
  place,
  mutagen,
  content,
  archive,
  rpc,
  mcp,
  config,
  until,
  run,
} from "./helpers.mjs";
import { ssh } from "./network.mjs";
const write = (root, file, value) =>
  NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, file)), { recursive: true }).then(() =>
    NodeFSP.writeFile(NodePath.join(root, file), value),
  );
const state = (node, p) => mcp(node, "t3_project_machines", { project: p.key });
export const replicaScenarios = {
  "installer-cold": async (directory) => {
    const realistic = process.env.MESH_FAST_REALISTIC === "1";
    const archive = await NodeFSP.readFile(
      NodePath.join(process.env.MESH_FAST_MUTAGEN_CACHE, "mutagen.tar.gz"),
    );
    let downloads = 0;
    const mirror = NodeHttp.createServer((request, response) => {
      if (
        request.method !== "GET" ||
        request.url !==
          "/mutagen-io/mutagen/releases/download/v0.18.1/mutagen_linux_amd64_v0.18.1.tar.gz"
      ) {
        response.writeHead(404).end();
        return;
      }
      downloads++;
      response.writeHead(200, { "content-length": archive.length }).end(archive);
    });
    const mirrorPort = await allocatePort();
    if (!realistic)
      await new Promise((resolve, reject) => {
        mirror.once("error", reject);
        mirror.listen(mirrorPort, "127.0.0.1", resolve);
      });
    try {
      await fixture(
        directory,
        async (mesh) => {
          const target = mesh.nodes[1];
          await NodeAssert.rejects(NodeFSP.stat(NodePath.join(target.base, "bin/mutagen")), {
            code: "ENOENT",
          });
          const p = await project(mesh, "cold-install"),
            rep = await place(target, p);
          NodeAssert.match(
            await run(NodePath.join(target.base, "bin/mutagen"), ["version"]),
            /0\.18\.1/,
          );
          await content(NodePath.join(rep.path, "README.md"), p.title);
          if (!realistic)
            NodeAssert.ok(downloads > 0, "The real installer must download its pinned archive");
          await NodeFSP.writeFile(
            NodePath.join(directory, "cold-install.json"),
            JSON.stringify({ downloads, version: "0.18.1", watching: true }),
          );
        },
        {
          coldInstall: true,
          names: ["studio", "laptop"],
          ...(!realistic
            ? {
                environment: { T3_MESH_TEST_ASSET_ORIGIN: `http://127.0.0.1:${mirrorPort}` },
                extraRoutes: [mirrorPort],
              }
            : {}),
        },
      );
    } finally {
      if (mirror.listening)
        await new Promise((resolve, reject) =>
          mirror.close((error) => (error ? reject(error) : resolve())),
        );
    }
  },
  "replica-policies": (directory) =>
    fixture(directory, async (mesh) => {
      const [studio, hub, laptop] = mesh.nodes,
        p = await project(mesh, "policies");
      await write(p.root, "src/build/source.ts", "nested source");
      await write(p.root, "build/out", "ignored");
      await write(p.root, "node_modules/deep/secret", "ignored");
      const a = await place(laptop, p),
        b = await place(hub, p);
      for (const node of mesh.nodes)
        for (const target of mesh.nodes.filter((peer) => peer !== node))
          NodeAssert.equal(await ssh(node, target, "printf managed"), "managed");
      for (const rep of [a, b]) {
        await content(NodePath.join(rep.path, "src/build/source.ts"), "nested source");
        for (const excluded of ["build", "node_modules", ".git"])
          await NodeAssert.rejects(NodeFSP.stat(NodePath.join(rep.path, excluded)), {
            code: "ENOENT",
          });
      }
      NodeAssert.equal((await place(laptop, p, { path: a.path })).path, a.path);
      const divergent = NodePath.join(laptop.home, "divergent");
      await write(divergent, "different", "preserve");
      await NodeAssert.rejects(
        mcp(laptop, "t3_project_place", { project: p.key, machine: laptop.id, path: divergent }),
        /differ|exists|occupied|path|empty/i,
      );
      const second = await project(mesh, "reverse", laptop);
      await place(studio, second);
      NodeAssert.equal((await state(studio, p)).representations.length, 3);
      await run("git", ["init", "-q", b.path]);
      await mcp(hub, "t3_project_place", {
        project: p.key,
        machine: hub.id,
        role: "primary",
        path: b.path,
      });
      await until(
        "two primaries remain one logical group",
        () => state(laptop, p),
        (value) =>
          value.logicalKey === p.key &&
          value.representations.filter((row) => row.role === "primary").length === 2,
      );

      const orphanA = NodePath.join(laptop.home, "orphan-a"),
        orphanB = NodePath.join(laptop.home, "orphan-b");
      await NodeFSP.mkdir(orphanA);
      await NodeFSP.mkdir(orphanB);
      await mutagen(
        laptop,
        "sync",
        "create",
        "--name",
        "fast-orphan",
        "-l",
        "t3-logical=deadbeef",
        "-l",
        "t3-env=orphan",
        orphanA,
        orphanB,
      );
      await until(
        "orphan visible",
        () => rpc(laptop, "replicas.status"),
        (value) =>
          value.replicas.some(
            (row) => row.sessionName === "fast-orphan" && /orphan/i.test(row.message),
          ),
      );
      NodeAssert.equal(
        JSON.parse(await mutagen(laptop, "sync", "list", "--template", "{{json .}}")).filter(
          (row) => row.name === "fast-orphan",
        ).length,
        1,
      );
    }),
  "replica-conflicts": (directory) =>
    fixture(
      directory,
      async (mesh) => {
        const [, laptop] = mesh.nodes,
          p = await project(mesh, "conflicts"),
          rep = await place(laptop, p);
        await mutagen(laptop, "sync", "pause", rep.session);
        await write(p.root, "README.md", "primary winner");
        await write(rep.path, "README.md", "replica loser");
        await mutagen(laptop, "sync", "resume", rep.session);
        await content(NodePath.join(rep.path, "README.md"), "primary winner");
        await archive(rep.path, "replica loser");
        await config(mesh, (doc) => ({
          ...doc,
          projects: {
            ...doc.projects,
            defaults: { ...doc.projects?.defaults, conflicts: "newest-wins" },
          },
        }));
        await mutagen(laptop, "sync", "pause", rep.session);
        await write(p.root, "README.md", "primary loser");
        await write(rep.path, "README.md", "newest winner");
        await NodeFSP.utimes(NodePath.join(p.root, "README.md"), 100, 100);
        await NodeFSP.utimes(NodePath.join(rep.path, "README.md"), 200, 200);
        await mutagen(laptop, "sync", "resume", rep.session);
        await content(NodePath.join(p.root, "README.md"), "newest winner");
        await archive(p.root, "primary loser");
        await mutagen(laptop, "sync", "pause", rep.session);
        await write(rep.path, "unsynced.txt", "retained");
        await NodeAssert.rejects(
          mcp(laptop, "t3_project_place", { project: p.key, machine: laptop.id, action: "remove" }),
          /unsynced.txt/,
        );
        await mutagen(laptop, "sync", "resume", rep.session);
        await content(NodePath.join(p.root, "unsynced.txt"), "retained");
        await mutagen(laptop, "sync", "flush", rep.session);
        await mcp(laptop, "t3_project_place", {
          project: p.key,
          machine: laptop.id,
          action: "remove",
        });
        await content(NodePath.join(rep.path, "unsynced.txt"), "retained");
        NodeAssert.ok(
          (await mcp(laptop, "t3_project_list", { limit: 100 })).projects.some(
            (item) => item.workspaceRoot === rep.path,
          ),
        );
      },
      { names: ["studio", "laptop"] },
    ),
  "replica-warnings": (directory) =>
    fixture(
      directory,
      async (mesh) => {
        const [, laptop] = mesh.nodes,
          p = await project(mesh, "warnings");
        await write(p.root, "private", "unreadable");
        await NodeFSP.chmod(NodePath.join(p.root, "private"), 0);
        await NodeFSP.symlink("../outside", NodePath.join(p.root, "outside"));
        try {
          const rep = await place(laptop, p);
          await until(
            "nonfatal scan problems",
            () => state(laptop, p),
            (value) =>
              value.representations.some(
                (item) =>
                  item.environmentId === laptop.id && item.projectId && item.status?.skipped >= 2,
              ),
          );
          const previous = JSON.parse(
            await mutagen(laptop, "sync", "list", "--template", "{{json .}}"),
          )[0].identifier;
          await config(mesh, (doc) => ({
            ...doc,
            projects: {
              ...doc.projects,
              overrides: [{ project: p.title, ignore: ["private", "outside"] }],
            },
          }));
          await until(
            "ignore session replacement",
            async () =>
              JSON.parse(await mutagen(laptop, "sync", "list", "--template", "{{json .}}")),
            (rows) =>
              rows.length === 1 &&
              rows[0].identifier !== previous &&
              rows[0].ignore.paths.includes("private"),
          );
          await until(
            "warnings cleared",
            () => state(laptop, p),
            (value) =>
              value.representations.some(
                (item) =>
                  item.environmentId === laptop.id &&
                  item.status?.state === "watching" &&
                  (item.status.skipped ?? 0) === 0,
              ),
          );
          await content(NodePath.join(rep.path, "README.md"), p.title);
        } finally {
          await NodeFSP.chmod(NodePath.join(p.root, "private"), 0o600);
        }
      },
      { names: ["studio", "laptop"] },
    ),
  "replica-full": (directory) =>
    fixture(
      directory,
      async (mesh) => {
        const [, laptop] = mesh.nodes,
          p = await project(mesh, "full");
        await write(
          p.root,
          "package.json",
          JSON.stringify({
            name: "mesh-fast-full",
            private: true,
            dependencies: { "mesh-fast-fixture": "file:./fixture-dependency" },
          }),
        );
        await write(
          p.root,
          "fixture-dependency/package.json",
          JSON.stringify({ name: "mesh-fast-fixture", version: "1.0.0", main: "index.cjs" }),
        );
        await write(
          p.root,
          "fixture-dependency/index.cjs",
          "module.exports='installed real dependency';\n",
        );
        await run(
          NodePath.join(process.env.MESH_FAST_MUTAGEN_CACHE, "pnpm-12.14.0/pnpm"),
          ["install", "--lockfile-only", "--offline"],
          { cwd: p.root, env: mesh.nodes[0].env },
        );
        const firstLock = await NodeFSP.readFile(NodePath.join(p.root, "pnpm-lock.yaml"), "utf8");
        await config(mesh, (doc) => ({
          ...doc,
          projects: { ...doc.projects, overrides: [{ project: p.title, replica: "full" }] },
        }));
        const rep = await place(laptop, p);
        await content(NodePath.join(rep.path, ".t3/installed-lock"), firstLock);
        NodeAssert.equal(
          await run(process.execPath, ["-e", "console.log(require('mesh-fast-fixture'))"], {
            cwd: rep.path,
            env: laptop.env,
          }),
          "installed real dependency",
        );
        NodeAssert.equal(
          await NodeFSP.readFile(NodePath.join(rep.path, ".t3/install-count"), "utf8"),
          "1",
        );
        const secondLock = firstLock + "\n# second frozen installation\n";
        await write(p.root, "pnpm-lock.yaml", secondLock);
        await content(NodePath.join(rep.path, ".t3/installed-lock"), secondLock);
        NodeAssert.equal(
          await NodeFSP.readFile(NodePath.join(rep.path, ".t3/install-count"), "utf8"),
          "2",
        );
        await until(
          "full ready status",
          () => state(laptop, p),
          (value) =>
            value.representations.some((item) => item.status?.message === "environment: ready"),
        );
      },
      { names: ["studio", "laptop"] },
    ),
};
for (const target of ["studio", "cloudbox", "laptop"])
  for (const phase of ["mount", "sync"])
    replicaScenarios[`crash-${target}-${phase}`] = (directory) =>
      fixture(
        directory,
        async (mesh) => {
          const p = await project(mesh, "crash"),
            driver = mesh.nodes[2],
            victim = mesh.nodes.find((node) => node.name === target);
          const payload = NodeCrypto.randomBytes(
              (process.env.MESH_FAST_REALISTIC === "1" ? 256 : 2) * 1024 * 1024,
            ),
            file = "transfer.bin";
          if (phase === "mount") await write(p.root, file, payload);
          else await place(driver, p);
          const traffic = await (await fetch(mesh.nodes[1].origin + "/__N1_network")).json();
          await mesh.fault(mesh.nodes[1], { pausePipeAfterBytes: traffic.pipeBytes + 512 * 1024 });
          const placing = (phase === "mount" ? place(driver, p) : Promise.resolve()).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          if (phase === "sync") await write(p.root, file, payload);
          await until(
            "active Mutagen staging before crash",
            async () =>
              JSON.parse(await mutagen(driver, "sync", "list", "--template", "{{json .}}")),
            (rows) => rows.some((row) => ["staging-alpha", "staging-beta"].includes(row.status)),
          );
          await mesh.restart(victim);
          await mesh.fault(mesh.nodes[1], {});
          const interrupted = await placing;
          if (interrupted.error)
            NodeAssert.match(
              interrupted.error.message,
              /peer|socket|closed|connect|offline|unreachable|deadline|mount|Ticket/i,
            );
          const rep = await place(driver, p);
          await until(
            "payload hash after crash",
            () => NodeFSP.readFile(NodePath.join(rep.path, file)),
            (value) => value.equals(payload),
          );
          const sessions = JSON.parse(
            await mutagen(driver, "sync", "list", "--template", "{{json .}}"),
          );
          NodeAssert.equal(sessions.length, 1);
        },
        { messageProxy: true, warmAgents: true },
      );
replicaScenarios["crash-mutagen"] = (directory) =>
  fixture(
    directory,
    async (mesh) => {
      const p = await project(mesh, "daemon"),
        driver = mesh.nodes[2],
        rep = await place(driver, p);
      const daemon = driver.mutagenDaemon;
      NodeAssert.ok(daemon);
      const traffic = await (await fetch(mesh.nodes[1].origin + "/__N1_network")).json();
      await mesh.fault(mesh.nodes[1], { pausePipeAfterBytes: traffic.pipeBytes + 512 * 1024 });
      const bytes = NodeCrypto.randomBytes(
        (process.env.MESH_FAST_REALISTIC === "1" ? 256 : 2) * 1024 * 1024,
      );
      await write(p.root, "daemon.bin", bytes);
      await until(
        "daemon staging",
        async () => JSON.parse(await mutagen(driver, "sync", "list", "--template", "{{json .}}")),
        (rows) => rows.some((row) => ["staging-alpha", "staging-beta"].includes(row.status)),
      );
      const inode = String(
        (await NodeFSP.stat(NodePath.join(driver.base, "mutagen/daemon/daemon.lock"))).ino,
      );
      const locks = await NodeFSP.readFile("/proc/locks", "utf8");
      NodeAssert.ok(
        locks
          .split("\n")
          .some(
            (line) =>
              line.includes(":" + inode + " ") &&
              line.trim().split(/\s+/)[4] === String(daemon.pid),
          ),
      );
      daemon.kill("SIGKILL");
      await mesh.fault(mesh.nodes[1], {});
      await until(
        "daemon recovered",
        () => NodeFSP.readFile(NodePath.join(rep.path, "daemon.bin")),
        (value) => value.equals(bytes),
      );
      const sessions = JSON.parse(
        await mutagen(driver, "sync", "list", "--template", "{{json .}}"),
      );
      NodeAssert.equal(sessions.length, 1);
      NodeAssert.equal(sessions[0].name, rep.session);
    },
    { messageProxy: true, warmAgents: true, captureMutagen: "laptop" },
  );
