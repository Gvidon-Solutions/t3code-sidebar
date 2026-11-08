import { bindingScenarios } from "./bindings.mjs";
import { forkScenarios } from "./forks.mjs";
import { cliScenarios } from "./cli.mjs";
import { metadataScenarios } from "./metadata.mjs";
import { skewScenarios } from "./skew.mjs";
import { uiScenarios } from "./ui.mjs";
import { rolloutScenarios } from "./rollout.mjs";
import { runScenarios } from "./runs.mjs";
import { threadScenarios } from "./threads.mjs";
import { layoutScenarios } from "./layout.mjs";
import { replicaScenarios } from "./replicas.mjs";
import { networkScenarios } from "./network.mjs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { run } from "./client.mjs";
import * as NodeAssert from "node:assert/strict";
import { MiniMesh, rpc, until, mcp } from "./mesh.mjs";

async function withMesh(directory, work) {
  const mesh = new MiniMesh(directory);
  try {
    await mesh.start();
    await work(mesh);
  } finally {
    await mesh.close();
  }
}
function clock(node, offset = 0) {
  return `${Date.now() + offset}.00000.${node.id}`;
}
async function apply(node, key, value, offset = 0) {
  return rpc(node, "meshLayout.apply", {
    entries: { [key]: { v: value, h: clock(node, offset) } },
  });
}
async function converged(nodes, expected) {
  await until(
    "all-entry convergence",
    () => Promise.all(nodes.map((node) => rpc(node, "meshLayout.get"))),
    (snapshots) =>
      snapshots.every(({ document }) =>
        Object.entries(expected).every(
          ([key, value]) => JSON.stringify(document[key]?.v) === JSON.stringify(value),
        ),
      ),
  );
}
export const scenarios = {
  "runner-cancel-boot": async (directory) => {
    const mesh = new MiniMesh(directory);
    const spawned = new Promise((resolve) => {
      mesh.onContainerSpawn = resolve;
    });
    let pending = true;
    const startup = mesh.start(["studio"]).then(
      () => {
        pending = false;
        return { started: true };
      },
      (error) => {
        pending = false;
        return { started: false, error: error.message };
      },
    );
    try {
      const container = await spawned;
      NodeAssert.equal(pending, true);
      NodeAssert.equal(mesh.nodes.length, 0);
      await mesh.close();
      const outcome = await startup;
      NodeAssert.equal(outcome.started, false);
      await NodeAssert.rejects(
        run("docker", ["container", "inspect", container.name]),
        /No such (object|container)/i,
      );
      await NodeAssert.rejects(
        run("docker", ["network", "inspect", mesh.network]),
        /No such network|network .* not found/i,
      );
      await NodeFSP.writeFile(
        NodePath.join(directory, "cancelled-boot.json"),
        JSON.stringify({
          pid: container.child.pid,
          container: container.name,
          network: mesh.network,
          outcome,
        }),
      );
    } finally {
      await mesh.close();
    }
  },
  ...bindingScenarios,
  ...forkScenarios,
  ...networkScenarios,
  ...replicaScenarios,
  ...layoutScenarios,
  ...threadScenarios,
  ...runScenarios,
  ...rolloutScenarios,
  ...uiScenarios,
  ...skewScenarios,
  ...metadataScenarios,
  ...cliScenarios,
  "replica-ssh": (directory) =>
    withMesh(directory, async (mesh) => {
      const [studio, , laptop] = mesh.nodes;
      for (const node of mesh.nodes) {
        const effective = await run("/usr/sbin/sshd", [
          "-T",
          "-f",
          NodePath.join(node.home, "sshd/sshd_config"),
        ]);
        for (const rule of ["permituserrc no", "permituserenvironment no", "usedns no"])
          NodeAssert.ok(effective.split("\n").includes(rule));
      }
      const source = NodePath.join(studio.home, "primary");
      await NodeFSP.mkdir(NodePath.join(source, "node_modules"), { recursive: true });
      const payload = Buffer.alloc(1024 * 1024, 42);
      await NodeFSP.writeFile(NodePath.join(source, "payload.bin"), payload);
      await NodeFSP.writeFile(NodePath.join(source, "node_modules", "ignored"), "private");
      await run("git", ["init", "-q", source]);
      const project = await mcp(studio, "t3_project_create", {
        title: "fast-replica",
        workspaceRoot: source,
      });
      await mcp(studio, "t3_project_place", {
        project: project.id,
        machine: studio.id,
        role: "primary",
        path: source,
      });
      const key = (await mcp(studio, "t3_project_machines", { project: project.id })).logicalKey;
      await mcp(laptop, "t3_project_place", { project: key, machine: laptop.id });
      const mounted = await until(
        "Mutagen replica watching",
        () => mcp(laptop, "t3_project_machines", { project: key }),
        (value) =>
          value.representations?.some(
            (rep) => rep.environmentId === laptop.id && rep.status?.state === "watching",
          ),
      );
      const replica = mounted.representations.find((rep) => rep.environmentId === laptop.id);
      const config = await rpc(laptop, "meshConfig.get");
      for (const target of mesh.nodes.filter((node) => node.id !== laptop.id)) {
        const slug = Object.keys(config.bindings).find((key) => config.bindings[key] === target.id);
        NodeAssert.ok(slug);
        NodeAssert.equal(
          await run(
            "ssh",
            [
              "-F",
              NodePath.join(laptop.home, ".ssh/config"),
              "t3-" + slug,
              "pwd; printf '%s' \"$HOME\"",
            ],
            { env: laptop.env },
          ),
          target.home + "\n" + target.home,
        );
      }
      const sourceName = Object.entries(config.bindings).find(([, id]) => id === studio.id)?.[0];
      NodeAssert.ok(sourceName);
      NodeAssert.equal(
        await run(
          "ssh",
          [
            "-F",
            NodePath.join(laptop.home, ".ssh", "config"),
            "t3-" + sourceName,
            "printf '%s' \"$HOME\"",
          ],
          { env: laptop.env },
        ),
        studio.home,
      );
      NodeAssert.deepEqual(
        await NodeFSP.readFile(NodePath.join(replica.path, "payload.bin")),
        payload,
      );
      await NodeAssert.rejects(NodeFSP.stat(NodePath.join(replica.path, "node_modules")), {
        code: "ENOENT",
      });
      await NodeAssert.rejects(NodeFSP.stat(NodePath.join(replica.path, ".git")), {
        code: "ENOENT",
      });
      NodeAssert.equal(
        mounted.representations.filter((rep) => rep.environmentId === laptop.id).length,
        1,
      );
    }),
  "layout-partition": (directory) =>
    withMesh(directory, async (mesh) => {
      const [studio, cloudbox, laptop] = mesh.nodes;
      await Promise.all([
        apply(studio, "future/studio", { revision: 2 }),
        apply(laptop, "future/laptop", ["opaque"]),
      ]);
      await converged(mesh.nodes, {
        "future/studio": { revision: 2 },
        "future/laptop": ["opaque"],
      });
      await mesh.fault(cloudbox, { cut: true });
      await until(
        "proxy partition active",
        async () => (await fetch(cloudbox.origin + "/__N1_network")).json(),
        (value) => value.state.cut && value.sockets === 0,
      );
      await until(
        "both leaves observe the cut",
        () => Promise.all([studio, laptop].map((node) => rpc(node, "meshLayout.status"))),
        (values) =>
          values.every((value) =>
            value.connections?.some(
              (row) => row.environmentId === cloudbox.id && row.state === "offline",
            ),
          ),
      );
      await apply(studio, "future/offline-studio", "retained");
      await apply(laptop, "future/offline-laptop", "retained");
      await mesh.fault(cloudbox, { cut: false });
      await converged(mesh.nodes, {
        "future/offline-studio": "retained",
        "future/offline-laptop": "retained",
      });
      await apply(studio, "future/studio", null);
      await converged(mesh.nodes, { "future/studio": null });
    }),
  "config-clock": (directory) =>
    withMesh(directory, async (mesh) => {
      const [studio] = mesh.nodes;
      const before = await rpc(studio, "meshConfig.get");
      const updated = await rpc(studio, "meshConfig.apply", {
        baseRevision: before.current.revision,
        doc: {
          ...before.current.doc,
          agents: { ...before.current.doc.agents, instructions: "mesh-fast private fixture" },
        },
      });
      await NodeAssert.rejects(
        rpc(studio, "meshConfig.apply", {
          baseRevision: before.current.revision,
          doc: before.current.doc,
        }),
        /stale/i,
      );
      await until(
        "config revision convergence",
        () => Promise.all(mesh.nodes.map((node) => rpc(node, "meshConfig.get"))),
        (values) => values.every((value) => value.current.revision === updated.revision),
      );
      await NodeAssert.rejects(
        apply(studio, "future/skew", "rejected", 3_600_000),
        /clock|invalid_entries/i,
      );
      for (const node of mesh.nodes)
        NodeAssert.equal((await rpc(node, "meshLayout.get")).document["future/skew"], undefined);
    }),
};
