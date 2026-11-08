import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";
import { MiniMesh, rpc, mcp, until } from "./mesh.mjs";
import { run } from "./client.mjs";
export { rpc, mcp, until, run };
export async function fixture(directory, work, options = {}) {
  const mesh = Object.assign(new MiniMesh(directory), options);
  const mark = (phase) =>
    NodeFSP.appendFile(
      NodePath.join(directory, "phases.jsonl"),
      JSON.stringify({ phase, at: new Date().toISOString() }) + "\n",
    );
  try {
    await mark("booting");
    await mesh.start(options.names);
    await mark("ready");
    await work(mesh);
    await mark("asserted");
    await invariant(mesh);
    await mark("converged");
  } finally {
    await mesh.close();
    await mark("closed");
  }
}
export async function config(mesh, update) {
  const hub = mesh.nodes[1],
    before = await rpc(hub, "meshConfig.get");
  const applied = await rpc(hub, "meshConfig.apply", {
    baseRevision: before.current.revision,
    doc: update(structuredClone(before.current.doc), before.bindings),
  });
  await until(
    "config delivery",
    () => Promise.all(mesh.nodes.map((node) => rpc(node, "meshConfig.get"))),
    (values) => values.every((value) => value.current.revision === applied.revision),
  );
  return applied;
}
export async function project(mesh, name = "fixture", source = mesh.nodes[0]) {
  const root = NodePath.join(source.home, name);
  await NodeFSP.mkdir(root, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "README.md"), name);
  await run("git", ["init", "-q", root]);
  const record = await mcp(source, "t3_project_create", { title: name, workspaceRoot: root });
  await mcp(source, "t3_project_place", {
    project: record.id,
    machine: source.id,
    role: "primary",
    path: root,
  });
  const state = await mcp(source, "t3_project_machines", { project: record.id });
  return { ...record, root, key: state.logicalKey, source };
}
export async function place(node, project, extra = {}) {
  await mcp(node, "t3_project_place", { project: project.key, machine: node.id, ...extra });
  const state = await until(
    "replica watching",
    () => mcp(node, "t3_project_machines", { project: project.key }),
    (value) =>
      value.representations?.some(
        (rep) => rep.environmentId === node.id && rep.status?.state === "watching",
      ),
  );
  const rep = state.representations.find((rep) => rep.environmentId === node.id);
  const live = await rpc(node, "replicas.status");
  return {
    ...rep,
    session: live.replicas.find(
      (rep) => rep.logicalKey === project.key && rep.environmentId === node.id,
    )?.sessionName,
  };
}
export async function mutagen(node, ...args) {
  return run(NodePath.join(node.base, "bin/mutagen"), args, {
    env: {
      ...node.env,
      MUTAGEN_DATA_DIRECTORY: NodePath.join(node.base, "mutagen"),
      MUTAGEN_SSH_PATH: NodePath.join(node.base, "mesh/ssh/bin"),
    },
  });
}
export async function content(file, expected) {
  await until(
    "file convergence: " + file,
    () => NodeFSP.readFile(file, "utf8"),
    (value) => value === expected,
  );
}
export async function archive(root, expected) {
  const visit = async (directory) => {
    const found = [];
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const file = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        NodeAssert.ok(!entry.name.includes(":"));
        found.push(...(await visit(file)));
      } else found.push(await NodeFSP.readFile(file, "utf8"));
    }
    return found;
  };
  await until(
    "losing version preserved",
    () => visit(NodePath.join(root, ".t3-conflicts")),
    (values) => values.includes(expected),
  );
}
const canonical = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
export async function invariant(mesh) {
  const barrier = {};
  for (const { document } of await Promise.all(
    mesh.nodes.map((node) => rpc(node, "meshLayout.get")),
  ))
    for (const [key, entry] of Object.entries(document))
      if (!barrier[key] || entry.h > barrier[key].h) barrier[key] = entry;
  await NodeFSP.writeFile(NodePath.join(mesh.directory, "barrier.json"), JSON.stringify(barrier));
  await until(
    "all entry HLC barrier",
    async () =>
      Promise.all(
        mesh.nodes.map(async (node) => {
          const { document } = await rpc(node, "meshLayout.get");
          return {
            node: node.name,
            missing: Object.entries(barrier).flatMap(([key, entry]) =>
              document[key] &&
              document[key].h >= entry.h &&
              (document[key].h !== entry.h || canonical(document[key].v) === canonical(entry.v))
                ? []
                : [
                    {
                      key,
                      expected: entry.h,
                      actual: document[key]?.h,
                      sameValue: canonical(document[key]?.v) === canonical(entry.v),
                    },
                  ],
            ),
          };
        }),
      ),
    (values) => values.every((value) => value.missing.length === 0),
  );
  await until(
    "identical materialized projects",
    () => Promise.all(mesh.nodes.map((node) => rpc(node, "meshLayout.get"))),
    (values) =>
      new Set(
        values.map(({ config }) =>
          canonical({
            mounts: config.projectMounts,
            titles: config.projectTitles,
            workspaces: config.projectWorkspaces,
          }),
        ),
      ).size === 1,
  );
  await Promise.all(
    mesh.nodes.map(async (node) => {
      const state = await rpc(node, "meshLayout.get");
      for (const reps of Object.values(state.config.projectMounts))
        NodeAssert.equal(new Set(reps.map((rep) => rep.environmentId)).size, reps.length);
      if (node.containerOwnedRoot) return;
      try {
        const sessions = await NodeFSP.readdir(NodePath.join(node.base, "mutagen/sessions"));
        if (!sessions.length) return;
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      const sessions = JSON.parse(await mutagen(node, "sync", "list", "--template", "{{json .}}"));
      NodeAssert.equal(new Set(sessions.map((session) => session.name)).size, sessions.length);
    }),
  );
}
