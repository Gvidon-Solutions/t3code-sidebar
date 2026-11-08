import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { fixture, config, rpc, until, run, content } from "./helpers.mjs";
const metrics = (node) => fetch(node.origin + "/__N1_network").then((response) => response.json());
export async function ssh(from, to, command) {
  const state = await rpc(from, "meshConfig.get");
  const name = Object.entries(state.bindings).find(([, id]) => id === to.id)?.[0];
  NodeAssert.ok(name);
  const args = [
    "-F",
    NodePath.join(from.home, ".ssh/config"),
    "-o",
    "BatchMode=yes",
    "t3-" + name,
    command,
  ];
  return from.container
    ? run("docker", [
        "exec",
        "-u",
        "node",
        "-e",
        "HOME=" + from.home,
        from.container,
        "ssh",
        ...args,
      ])
    : run("ssh", args, { env: from.env });
}
export const networkScenarios = Object.fromEntries(
  ["cut", "delay", "drop-idle", "reset", "ip-change", "sleep", "mid-pipe"].map((mode) => [
    "network-" + mode,
    (directory) =>
      fixture(directory, async (mesh) => {
        const [studio, hub, laptop] = mesh.nodes;
        await config(mesh, (doc) => ({
          ...doc,
          links: { ...doc.links, default: { files: "all", replicas: true, threads: true } },
        }));
        const file = NodePath.join(studio.home, "network-proof");
        await NodeFSP.writeFile(file, "persistent relay");
        await until(
          "relayed SSH",
          () => ssh(laptop, studio, "cat " + file),
          (value) => value === "persistent relay",
        );
        for (const node of mesh.nodes)
          await mesh.fault(node, { denyMcp: true, peerOnlyMcp: true, denyPeer: node === studio });
        const baselines = await Promise.all(mesh.nodes.map(metrics));
        if (mode === "sleep") {
          await mesh.signal(studio, "SIGSTOP");
          try {
            await until(
              "sleep detected",
              () => rpc(laptop, "meshLayout.status"),
              (value) =>
                value.connections.some(
                  (row) => row.environmentId === studio.id && row.state === "offline",
                ),
            );
            await new Promise((resolve) =>
              setTimeout(resolve, 600_000 * (process.env.MESH_FAST_REALISTIC === "1" ? 1 : 0.075)),
            );
          } finally {
            await mesh.signal(studio, "SIGCONT");
          }
        } else if (mode === "ip-change") {
          studio.serverArgs[studio.serverArgs.indexOf("--host") + 1] = "127.0.0.2";
          await mesh.fault(studio, {
            denyMcp: true,
            peerOnlyMcp: true,
            denyPeer: true,
            backendHost: "127.0.0.2",
          });
          await mesh.restart(studio);
        } else if (mode === "mid-pipe") {
          const payload = NodeCrypto.randomBytes(
            (process.env.MESH_FAST_REALISTIC === "1" ? 128 : 1) * 1024 * 1024,
          ).toString("hex");
          await NodeFSP.writeFile(file, payload);
          const before = await metrics(hub);
          await mesh.fault(hub, {
            denyMcp: true,
            peerOnlyMcp: true,
            resetAfterBytes: before.bytes + payload.length / 2,
          });
          const interrupted = await ssh(laptop, studio, "cat " + file).then(
            () => {
              throw Error("Mid-transfer reset did not interrupt SSH");
            },
            (error) => error,
          );
          NodeAssert.ok(
            interrupted.stdout.length > 0 && interrupted.stdout.length < payload.length,
          );
          NodeAssert.ok(payload.startsWith(interrupted.stdout));
          NodeAssert.ok((await metrics(hub)).resets > before.resets);
          await mesh.fault(hub, { denyMcp: true, peerOnlyMcp: true });
          await until(
            "mid-pipe recovery hash",
            () => ssh(laptop, studio, "sha256sum " + file),
            (value) =>
              value.startsWith(NodeCrypto.createHash("sha256").update(payload).digest("hex")),
          );
          await NodeFSP.writeFile(file, "persistent relay");
        } else if (mode === "delay") {
          await mesh.fault(hub, { denyMcp: true, peerOnlyMcp: true, delayMs: 30 });
          NodeAssert.equal(
            (await rpc(laptop, "files.read", { environmentId: studio.id, absolutePath: file }))
              .contents,
            "persistent relay",
          );
          await mesh.fault(hub, { denyMcp: true, peerOnlyMcp: true });
        } else {
          const before = await metrics(hub);
          await mesh.fault(hub, {
            denyMcp: true,
            peerOnlyMcp: true,
            ...(mode === "cut"
              ? { cut: true }
              : mode === "reset"
                ? { reset: true }
                : { idleMs: 20 }),
          });
          await until(
            "fault observed",
            () => metrics(hub),
            (value) =>
              mode === "drop-idle"
                ? value.peerIdleDrops > before.peerIdleDrops
                : value.peerResets > before.peerResets,
          );
          await mesh.fault(hub, { denyMcp: true, peerOnlyMcp: true });
        }
        await until(
          "network recovery",
          () => rpc(laptop, "files.read", { environmentId: studio.id, absolutePath: file }),
          (value) => value.contents === "persistent relay",
        );
        await until(
          "SSH recovers after network fault",
          () => ssh(laptop, studio, "cat " + file),
          (value) => value === "persistent relay",
        );
        for (const [index, node] of mesh.nodes.entries()) {
          const result = await metrics(node);
          NodeAssert.equal(
            result.peerMcp - result.refusedPeerMcp,
            baselines[index].peerMcp - baselines[index].refusedPeerMcp,
          );
        }
        await content(file, "persistent relay");
      }),
  ]),
);
