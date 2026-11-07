import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { fixture, rpc, mcp, until, project, config } from "./helpers.mjs";
const hlc = (node, offset = 0) => `${Date.now() + offset}.00000.${node.id}`;
const edit = (node, entries) =>
  rpc(node, "meshLayout.apply", {
    entries: Object.fromEntries(
      Object.entries(entries).map(([key, v]) => [key, { v, h: hlc(node) }]),
    ),
  });
export const layoutScenarios = {
  "layout-legacy-edits": (directory) =>
    fixture(
      directory,
      async (mesh) => {
        const [studio, hub, laptop] = mesh.nodes,
          p = await project(mesh, "workspace-edits");
        const initial = await rpc(studio, "meshLayout.get");
        NodeAssert.equal(
          initial.config.workspaces.filter((ws) => ws.name.toLowerCase() === "main").length,
          1,
        );
        for (const node of mesh.nodes) {
          const alias = initial.config.projectAliases["title:seed-" + node.name];
          NodeAssert.ok(alias?.startsWith("lp-"));
          NodeAssert.ok(initial.config.projectOrder.includes(alias));
        }
        const defaultId = initial.config.defaultWorkspace;
        await edit(studio, {
          "ws/fast-scratch": { name: "scratch", sort: "z0" },
          "ws/fast-front": { name: "front", sort: "zz0" },
        });
        await until(
          "scratch created everywhere",
          () => rpc(laptop, "meshLayout.get"),
          (value) => value.config.workspaces.some((ws) => ws.id === "fast-scratch"),
        );
        await Promise.all([
          edit(studio, { "ws/fast-scratch": { name: "renamed", sort: "z0" } }),
          edit(laptop, {
            ["place/" + p.key + "/fast-scratch"]: { sort: "a0", placed: true, ordered: true },
          }),
          edit(hub, { "ws/fast-front": { name: "front", sort: "00" } }),
        ]);
        await until(
          "independent rename placement reorder survive",
          () => Promise.all(mesh.nodes.map((node) => rpc(node, "meshLayout.get"))),
          (values) =>
            values.every(
              (value) =>
                value.config.workspaces[0].id === "fast-front" &&
                value.config.workspaces.some(
                  (ws) => ws.id === "fast-scratch" && ws.name === "renamed",
                ) &&
                value.config.placements[p.key]?.includes("fast-scratch"),
            ),
        );
        await edit(laptop, {
          ["fold/fast-scratch/" + p.key]: "quiet",
          "ws.default": "fast-scratch",
          "ws.quietAfterDays": 9,
        });
        await until(
          "fold and default replicated",
          () => rpc(studio, "meshLayout.get"),
          (value) =>
            value.config.workspaceFold["fast-scratch"]?.[p.key] === "quiet" &&
            value.config.defaultWorkspace === "fast-scratch" &&
            value.config.quietAfterDays === 9,
        );
        await edit(studio, {
          "ws/fast-scratch": null,
          "ws/fast-front": null,
          ["place/" + p.key + "/fast-scratch"]: null,
          ["fold/fast-scratch/" + p.key]: null,
          "ws.default": defaultId,
          "ws.quietAfterDays": 5,
        });
        await until(
          "deleted workspace tombstone reaches each node",
          () => Promise.all(mesh.nodes.map((node) => rpc(node, "meshLayout.get"))),
          (values) =>
            values.every(
              (value) =>
                value.document["ws/fast-scratch"]?.v === null &&
                !value.config.workspaces.some((ws) => ws.id === "fast-scratch"),
            ),
        );
      },
      { legacySeed: true },
    ),
  "mixed-version": (directory) =>
    fixture(
      directory,
      async (mesh) => {
        const [studio, , laptop] = mesh.nodes;
        await edit(studio, { "future/mixed": { unknown: { preserved: true } } });
        await until(
          "real N-1 forwarding",
          () => rpc(laptop, "meshLayout.get"),
          (value) => value.document["future/mixed"]?.v?.unknown?.preserved,
        );
        await mesh.restart(laptop);
        await until(
          "N-1 restart retains unknown fields",
          () => rpc(laptop, "meshLayout.get"),
          (value) => value.document["future/mixed"]?.v?.unknown?.preserved,
        );
      },
      { previousEntry: process.env.MESH_FAST_PREVIOUS_ENTRY },
    ),
  "layout-files": (directory) =>
    fixture(directory, async (mesh) => {
      const [studio, hub, laptop] = mesh.nodes,
        p = await project(mesh, "files");
      await until(
        "catalog without placement",
        () => mcp(laptop, "t3_project_machines", { project: p.title }),
        (value) =>
          value.logicalKey === p.key &&
          value.representations.some((rep) => rep.environmentId === studio.id),
      );
      NodeAssert.equal((await rpc(laptop, "meshLayout.get")).config.projectMounts[p.key].length, 1);
      const path = NodePath.join(p.root, "README.md");
      NodeAssert.equal(
        (await rpc(laptop, "files.read", { environmentId: studio.id, absolutePath: path }))
          .contents,
        p.title,
      );
      NodeAssert.ok(
        (
          await rpc(laptop, "files.list", {
            environmentId: studio.id,
            partialPath: p.root + "/REA",
            limit: 40,
          })
        ).entries.some((entry) => JSON.stringify(entry).includes("README")),
      );
      await NodeAssert.rejects(
        rpc(laptop, "files.read", {
          environmentId: studio.id,
          absolutePath: NodePath.join(studio.home, "outside"),
        }),
        /project|permission|outside|not_found/i,
      );
      for (const [name, bytes] of [
        ["binary", Buffer.from([0, 1, 2])],
        ["large", Buffer.alloc(3 * 1024 * 1024, 65)],
      ]) {
        const file = NodePath.join(p.root, name);
        await NodeFSP.writeFile(file, bytes);
        if (name === "large") await NodeFSP.truncate(file, 65 * 1024 * 1024);
        await NodeAssert.rejects(
          rpc(laptop, "files.read", { environmentId: studio.id, absolutePath: file }),
          /binary|large|limit|size/i,
        );
      }
      await NodeAssert.rejects(
        rpc(laptop, "files.read", {
          environmentId: studio.id,
          absolutePath: NodePath.join(p.root, "missing"),
        }),
        /not_found|exist|missing/i,
      );
      await config(mesh, (doc) => ({
        ...doc,
        links: { ...doc.links, default: { files: "none", replicas: true, threads: true } },
      }));
      await NodeAssert.rejects(
        rpc(laptop, "files.read", { environmentId: studio.id, absolutePath: path }),
        /permission|denied|disabled|does not allow/i,
      );
      NodeAssert.ok((await rpc(hub, "replicas.status")).replicas);
    }),
  "layout-legacy-concurrent": (directory) =>
    fixture(directory, async (mesh) => {
      const [studio, hub, laptop] = mesh.nodes;
      const before = await rpc(hub, "server.getConfig");
      await Promise.all([
        edit(studio, { "future/concurrent-a": 1 }),
        edit(laptop, { "future/concurrent-b": 2 }),
        rpc(hub, "server.updateSettings", {
          patch: { sidebarWorkspaces: before.settings.sidebarWorkspaces },
        }),
      ]);
      await until(
        "concurrent and old client edits retained",
        () => Promise.all(mesh.nodes.map((node) => rpc(node, "meshLayout.get"))),
        (values) =>
          values.every(
            (value) =>
              value.document["future/concurrent-a"]?.v === 1 &&
              value.document["future/concurrent-b"]?.v === 2,
          ),
      );
      for (const node of mesh.nodes)
        await until(
          "stable legacy materialization",
          async () => {
            const before = await rpc(node, "meshLayout.get"),
              settings = await rpc(node, "server.getConfig"),
              after = await rpc(node, "meshLayout.get");
            return { before, settings, after };
          },
          (value) =>
            JSON.stringify(value.before.config) === JSON.stringify(value.after.config) &&
            JSON.stringify(value.settings.settings.sidebarWorkspaces) ===
              JSON.stringify(value.after.config),
        );
    }),
  "identity-collisions-unknown-version": (directory) =>
    fixture(
      directory,
      async (mesh) => {
        const reports = await Promise.all(mesh.nodes.map((node) => rpc(node, "meshConfig.get")));
        const current = reports[0];
        NodeAssert.equal(Object.keys(current.bindings).length, mesh.nodes.length);
        NodeAssert.equal(new Set(Object.values(current.bindings)).size, mesh.nodes.length);
        const names = Object.keys(current.bindings);
        NodeAssert.equal(new Set(names).size, mesh.nodes.length);
        const [studio, , laptop] = mesh.nodes;
        await edit(studio, { "future/vNext": { schema: 999, nested: { opaque: true } } });
        await mesh.restart(laptop);
        await until(
          "N-1 opaque forwarding after restart",
          () => rpc(laptop, "meshLayout.get"),
          (value) => value.document["future/vNext"]?.v?.nested?.opaque === true,
        );
        await NodeAssert.rejects(
          rpc(studio, "meshLayout.apply", {
            entries: { "proj/invalid": { v: { invalid: true }, h: hlc(studio) } },
          }),
          /invalid|schema|title/i,
        );
        await NodeAssert.rejects(
          rpc(studio, "meshLayout.apply", {
            entries: { "future/skew": { v: true, h: hlc(studio, 3_600_000) } },
          }),
          /clock|invalid/i,
        );
      },
      { preserveIdentity: true },
    ),
  "crash-restart-orders": (directory) =>
    fixture(directory, async (mesh) => {
      const [a, b, c] = mesh.nodes;
      for (const order of [
        [a, b, c],
        [a, c, b],
        [b, a, c],
        [b, c, a],
        [c, a, b],
        [c, b, a],
      ]) {
        await edit(order[0], {
          ["future/restart-" + order.map((node) => node.name).join("-")]: "retained",
        });
        for (const node of order) await mesh.restart(node);
      }
    }),
};
