import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { fixture, rpc, until, run, config } from "./helpers.mjs";
const canonical = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
async function identical(mesh) {
  return until(
    "sameBindings and sameConfig",
    () => Promise.all(mesh.nodes.map((node) => rpc(node, "meshConfig.get"))),
    (values) =>
      new Set(values.map((v) => canonical({ bindings: v.bindings, current: v.current }))).size ===
        1 && Object.keys(values[0].bindings).length === 3,
  );
}
async function collisions(directory, reverseJoins) {
  return fixture(
    directory,
    async (mesh) => {
      const [studio, hub, laptop] = mesh.nodes;
      let values = await identical(mesh);
      const bindings = values[0].bindings;
      NodeAssert.deepEqual(Object.keys(bindings).sort(), ["cloudbox", "studio", "studio-2"]);
      const claimOrder = [studio.id, laptop.id].sort();
      NodeAssert.equal(bindings.studio, claimOrder[0]);
      NodeAssert.equal(bindings["studio-2"], claimOrder[1]);
      for (const slug of ["studio", "studio-2"])
        NodeAssert.equal(
          await run(
            "ssh",
            ["-F", NodePath.join(hub.home, ".ssh/config"), "t3-" + slug, "hostname"],
            {
              env: hub.env,
            },
          ),
          "studio",
        );
      const revision = values[0].current.revision;
      const missing = Object.keys(bindings).find((key) => bindings[key] === laptop.id);
      await Promise.all(mesh.nodes.map((node) => mesh.stop(node)));
      for (const node of mesh.nodes) {
        const db = new NodeSqlite.DatabaseSync(NodePath.join(node.base, "userdata/statev2.sqlite"));
        try {
          db.prepare("DELETE FROM mesh_layout_entries WHERE key = ? OR key = ?").run(
            "mesh.machineBinding/" + missing,
            "mesh.machineClaim/" + laptop.id,
          );
        } finally {
          db.close();
        }
      }
      await Promise.all(mesh.nodes.map((node) => mesh.resume(node)));
      values = await identical(mesh);
      NodeAssert.deepEqual(values[0].bindings, bindings);
      NodeAssert.notEqual(
        values[0].current.revision,
        revision,
        "repair must publish a fresh revision",
      );
      const old = Object.keys(bindings).find((key) => bindings[key] === studio.id);
      const destination = values[0].current.doc.machines[old].ssh;
      await config(mesh, (doc) => {
        doc.machines.renamed = doc.machines[old];
        delete doc.machines[old];
        return doc;
      });
      values = await identical(mesh);
      NodeAssert.equal(values[0].bindings.renamed, studio.id);
      NodeAssert.notEqual(values[0].bindings[old], studio.id);
      NodeAssert.deepEqual(values[0].current.doc.machines.renamed.ssh, destination);
      await until(
        "renamed managed ProxyCommand",
        () => NodeFSP.readFile(NodePath.join(hub.home, ".ssh/config"), "utf8"),
        (text) =>
          text.includes("Host t3-renamed\n") &&
          text.split("Host t3-renamed\n")[1].split("\nHost ")[0].includes(studio.id),
      );
      NodeAssert.equal(
        await run("ssh", ["-F", NodePath.join(hub.home, ".ssh/config"), "t3-renamed", "hostname"], {
          env: hub.env,
        }),
        "studio",
      );
      await NodeFSP.writeFile(
        NodePath.join(directory, "bindings.json"),
        JSON.stringify({ sameBindings: true, sameConfig: true, values }, null, 2),
      );
    },
    {
      containerNames: ["studio", "laptop"],
      hostnames: { studio: "studio", laptop: "studio" },
      preserveIdentity: ["studio", "laptop"],
      concurrentJoins: true,
      reverseJoins,
    },
  );
}
export const bindingScenarios = {
  "c2-concurrent-forward": (directory) => collisions(directory, false),
  "c2-concurrent-reverse": (directory) => collisions(directory, true),
};
