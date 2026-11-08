import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  fixture,
  project,
  place,
  rpc,
  mcp,
  until,
  config,
  content,
  archive,
  run,
} from "./helpers.mjs";
const entry = (node, key, v) =>
  rpc(node, "meshLayout.apply", { entries: { [key]: { v, h: `${Date.now()}.00000.${node.id}` } } });
export const metadataScenarios = {
  "config-rules-agents": (directory) =>
    fixture(directory, async (mesh) => {
      const [studio, , laptop] = mesh.nodes,
        p = await project(mesh, "automatic-rule");
      // Agent-kit files follow installed harnesses; seed Codex so its managed block is in scope.
      await Promise.all(
        mesh.nodes.map((node) =>
          NodeFSP.mkdir(NodePath.join(node.home, ".codex"), { recursive: true }),
        ),
      );
      const before = await rpc(studio, "meshConfig.get"),
        name = Object.keys(before.bindings).find((key) => before.bindings[key] === laptop.id);
      const desired = {
        ...before.current.doc,
        machines: {
          ...before.current.doc.machines,
          [name]: { ...before.current.doc.machines[name], title: "Portable laptop", label: "LP" },
        },
        replicas: { rules: [{ project: p.title, on: name, when: "always" }] },
        agents: { ...before.current.doc.agents, instructions: "fast-managed-instruction" },
      };
      NodeAssert.ok((await rpc(studio, "meshConfig.plan", { doc: desired })).actions.length);
      NodeAssert.equal(
        (await rpc(studio, "meshConfig.get")).current.revision,
        before.current.revision,
      );
      const applied = await rpc(studio, "meshConfig.apply", {
        baseRevision: before.current.revision,
        doc: desired,
      });
      await until(
        "rule creates actual replica",
        () => mcp(studio, "t3_project_machines", { project: p.key }),
        (value) =>
          value.representations.some(
            (row) => row.environmentId === laptop.id && row.status?.state === "watching",
          ),
      );
      await until(
        "rename materialized on each node",
        () => Promise.all(mesh.nodes.map((node) => rpc(node, "meshLayout.get"))),
        (values) =>
          values.every(
            (value) =>
              value.config.machines[laptop.id]?.title === "Portable laptop" &&
              value.config.machines[laptop.id]?.tag === "LP",
          ),
      );
      NodeAssert.ok(
        (await mcp(studio, "t3_mesh_config_history")).revisions.some(
          (row) => row.revision === applied.revision,
        ),
      );
      for (const node of mesh.nodes) {
        const slug = Object.keys(before.bindings).find((key) => before.bindings[key] === node.id);
        const machine = desired.machines[slug];
        const header = `This machine: ${machine.title ?? slug} (${machine.label ?? slug}).`;
        await until(
          "managed instruction install",
          () => NodeFSP.readFile(NodePath.join(node.home, ".codex/AGENTS.md"), "utf8"),
          (text) => text.includes("fast-managed-instruction") && text.includes(header),
        );
      }
      await NodeAssert.rejects(
        rpc(studio, "meshConfig.apply", {
          baseRevision: applied.revision,
          doc: { ...desired, schema: 999 },
        }),
        /schema|version|invalid/i,
      );
    }),
  "layout-path-claims": (directory) =>
    fixture(directory, async (mesh) => {
      const [studio, hub] = mesh.nodes,
        p = await project(mesh, "claims", hub);
      const rep = (await mcp(hub, "t3_project_machines", { project: p.key })).representations[0];
      await entry(hub, `rep/lp-first/${hub.id}`, rep);
      await until(
        "first claim",
        () => rpc(studio, "meshLayout.get"),
        (value) => value.config.projectMounts["lp-first"]?.length === 1,
      );
      await entry(studio, `rep/lp-latest/${hub.id}`, rep);
      await until(
        "LWW duplicate path winner",
        () => Promise.all(mesh.nodes.map((node) => rpc(node, "meshLayout.get"))),
        (values) =>
          values.every(
            (value) =>
              value.config.projectMounts["lp-latest"]?.length === 1 &&
              !value.config.projectMounts["lp-first"]?.length,
          ),
      );
    }),
  "layout-alias-transports": (directory) =>
    fixture(
      directory,
      async (mesh) => {
        const [studio, hub, laptop] = mesh.nodes,
          title = "Legacy title",
          legacy = "title:legacy title",
          root = NodePath.join(hub.home, "legacy");
        await NodeFSP.mkdir(root);
        await run("git", ["init", "-q", root]);
        await NodeFSP.writeFile(NodePath.join(root, "local.cache"), "ignored");
        await NodeFSP.writeFile(NodePath.join(root, "private.legacyignored"), "legacy exclusion");
        await NodeFSP.writeFile(NodePath.join(root, "bundle.zip"), "legacy lists stay explicit");
        NodeAssert.deepEqual((await rpc(hub, "meshConfig.get")).current.doc.replicas.ignore, [
          "*.legacyignored",
        ]);
        const local = await mcp(hub, "t3_project_create", { title, workspaceRoot: root });
        await entry(studio, `proj/${encodeURIComponent(legacy)}.title`, title);
        const state = await until(
          "legacy alias migrates",
          () => rpc(hub, "meshLayout.get"),
          (value) => value.config.projectAliases[legacy]?.startsWith("lp-"),
        );
        const key = state.config.projectAliases[legacy];
        NodeAssert.equal(
          (
            await mcp(hub, "t3_project_place", {
              project: local.id,
              machine: hub.id,
              role: "primary",
              path: root,
            })
          ).logicalKey,
          key,
        );
        const p = { ...local, key, title, root };
        await config(mesh, (doc) => ({
          ...doc,
          projects: { ...doc.projects, overrides: [{ project: title, ignore: ["*.cache"] }] },
        }));
        const rep = await place(laptop, p, { path: NodePath.join(laptop.home, "explicit") });
        await NodeAssert.rejects(NodeFSP.stat(NodePath.join(rep.path, "local.cache")), {
          code: "ENOENT",
        });
        await NodeAssert.rejects(NodeFSP.stat(NodePath.join(rep.path, "private.legacyignored")), {
          code: "ENOENT",
        });
        await content(NodePath.join(rep.path, "bundle.zip"), "legacy lists stay explicit");
        const manual = NodePath.join(studio.home, "external");
        await NodeFSP.mkdir(manual);
        for (const transport of ["manual", "sshfs"]) {
          await mcp(studio, "t3_project_place", {
            project: key,
            machine: studio.id,
            path: manual,
            transport,
          });
          await until(
            "external transport metadata",
            () => mcp(studio, "t3_project_machines", { project: key }),
            (value) =>
              value.representations.some(
                (row) =>
                  row.environmentId === studio.id && row.transport === transport && row.projectId,
              ),
          );
        }
        await entry(laptop, `proj/${key}.title`, "Renamed title");
        await until(
          "display title shared",
          () => mcp(hub, "t3_project_machines", { project: local.id }),
          (value) => value.title === "Renamed title",
        );
        NodeAssert.equal(
          (await mcp(hub, "t3_project_read", { projectId: local.id })).title,
          "Renamed title",
        );
      },
      { legacyIgnores: ["*.legacyignored"] },
    ),
  "replica-foreign-adoption": (directory) =>
    fixture(directory, async (mesh) => {
      const [, hub, laptop] = mesh.nodes,
        p = await project(mesh, "adoption", hub),
        target = NodePath.join(laptop.home, "adopt-target");
      await NodeFSP.mkdir(target);
      const before = await rpc(laptop, "meshConfig.get"),
        name = Object.keys(before.bindings).find((key) => before.bindings[key] === hub.id);
      const foreign = async (...args) =>
        run(NodePath.join(laptop.base, "bin/mutagen"), args, {
          env: {
            ...laptop.env,
            MUTAGEN_DATA_DIRECTORY: NodePath.join(laptop.home, ".mutagen"),
            MUTAGEN_SSH_PATH: NodePath.join(laptop.base, "mesh/ssh/bin"),
          },
        });
      try {
        await foreign(
          "sync",
          "create",
          "--name",
          "foreign-reversed",
          "--mode",
          "two-way-safe",
          "--ignore-vcs",
          "--ignore",
          ".t3-conflicts",
          target,
          `t3-${name}:${p.root}`,
        );
        await foreign("sync", "flush", "foreign-reversed");
        await foreign("sync", "pause", "foreign-reversed");
        await NodeFSP.writeFile(NodePath.join(p.root, "README.md"), "adoption loser");
        await NodeFSP.writeFile(NodePath.join(target, "README.md"), "adoption winner");
        await NodeFSP.utimes(NodePath.join(p.root, "README.md"), 100, 100);
        await NodeFSP.utimes(NodePath.join(target, "README.md"), 200, 200);
        await config(mesh, (doc) => ({
          ...doc,
          projects: {
            ...doc.projects,
            overrides: [{ project: p.title, conflicts: "newest-wins" }],
          },
        }));
        await rpc(laptop, "replicas.adopt", { session: "foreign-reversed", project: p.title });
        await until(
          "adopted private driver watches",
          () => mcp(laptop, "t3_project_machines", { project: p.key }),
          (value) =>
            value.representations.some(
              (row) =>
                row.environmentId === laptop.id &&
                row.status?.state === "watching" &&
                !row.adoption,
            ),
        );
        NodeAssert.ok(
          !JSON.parse(await foreign("sync", "list", "--template", "{{json .}}")).some(
            (row) => row.name === "foreign-reversed",
          ),
        );
        await content(NodePath.join(p.root, "README.md"), "adoption winner");
        await archive(p.root, "adoption loser");
      } finally {
        await foreign("daemon", "stop");
      }
    }),
};
