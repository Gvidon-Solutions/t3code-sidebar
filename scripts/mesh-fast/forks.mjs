import { realProviders } from "./real-providers.mjs";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import { fixture, project, mcp, rpc, until } from "./helpers.mjs";
import { providers, completed } from "./threads.mjs";
async function launch(node, p) {
  const source = await mcp(node, "t3_thread_launch", {
    projectId: p.id,
    title: "fork-source",
    message: "fixture",
    modelSelection: { instanceId: "fakeCodex", model: "fast" },
    runtimeMode: "full-access",
  });
  await completed(node, source.threadId);
  return source;
}
const items = (read) => read.items.map(({ updatedAt: _updatedAt, ...item }) => item);
async function receiver(source, target) {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(source.base, "userdata/statev2.sqlite"), {
    readOnly: true,
  });
  let secret;
  try {
    secret = db
      .prepare("SELECT secret_name FROM peer_environment_links WHERE environment_id = ?")
      .get(target.id).secret_name;
  } finally {
    db.close();
  }
  return {
    ...target,
    mcpToken: await NodeFSP.readFile(
      NodePath.join(source.base, "userdata/secrets", secret + ".bin"),
      "utf8",
    ),
    mcpInitialized: false,
    mcpSession: undefined,
  };
}
async function journals(node) {
  const directory = NodePath.join(node.base, "userdata/fork-transactions");
  try {
    return await Promise.all(
      (await NodeFSP.readdir(directory))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) =>
          JSON.parse(await NodeFSP.readFile(NodePath.join(directory, name), "utf8")),
        ),
    );
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
export const forkScenarios = {
  "fork-dropped-commit": (directory) =>
    fixture(
      directory,
      async (mesh) => {
        await providers(mesh);
        const [studio, target] = mesh.nodes,
          p = await project(mesh, "fork-retry"),
          source = await launch(studio, p);
        await mesh.fault(target, { observeCommit: true, reset: true });
        await until(
          "commit proxy installed",
          async () => (await fetch(target.origin + "/__mesh_network")).json(),
          (v) => v.state.observeCommit && v.sockets === 0,
        );
        await mesh.fault(target, { observeCommit: true });
        await until(
          "instrumented native peer reconnected",
          () => rpc(studio, "meshLayout.status"),
          (value) =>
            value.connections.some(
              (row) => row.environmentId === target.id && row.state === "direct",
            ),
        );
        await mesh.fault(target, { observeCommit: true, denyMcp: true, peerOnlyMcp: true });
        const commandId = NodeCrypto.randomUUID();
        const result = await rpc(studio, "threads.fork", {
          commandId,
          threadId: source.threadId,
          targetEnvironmentId: target.id,
          modelSelection: { instanceId: "fakeCodex", model: "fast" },
        });
        await until(
          "dropped response retried",
          async () => (await fetch(target.origin + "/__mesh_network")).json(),
          (v) => v.droppedCommitResponses === 1 && v.commitCalls >= 2,
        );
        const read = await mcp(target, "t3_thread_read", { threadId: result.threadId });
        NodeAssert.match(JSON.stringify(read), /FAST_DONE/);
        const receipts = await journals(target);
        NodeAssert.equal(
          receipts.filter(
            (entry) => entry.key === "target:" + commandId && entry.value.phase === "committed",
          ).length,
          1,
        );
        const list = await mcp(target, "t3_thread_list", { allProjects: true, limit: 100 });
        await NodeFSP.writeFile(
          NodePath.join(directory, "retry.json"),
          JSON.stringify({ result, receipts, list }),
        );
        NodeAssert.equal(
          list.threads.filter((thread) => thread.threadId === result.threadId).length,
          1,
        );
        NodeAssert.equal(list.total, 1);
      },
      { names: ["studio", "cloudbox"] },
    ),
  "fork-replica-content": (directory) =>
    fixture(directory, async (mesh) => {
      const real = process.env.MESH_FAST_REAL_PROVIDERS === "1";
      await (real ? realProviders(mesh) : providers(mesh));
      const [studio, , target] = mesh.nodes,
        p = await project(mesh, "fork-content");
      const marker = NodeCrypto.randomBytes(24).toString("hex");
      await NodeFSP.writeFile(NodePath.join(p.root, "README.md"), marker);
      const source = real
        ? await mcp(studio, "t3_thread_launch", {
            projectId: p.id,
            title: "fork-native-source",
            modelSelection: {
              instanceId: "codex",
              model: process.env.MESH_E2E_CODEX_MODEL ?? "gpt-6-luna",
            },
            runtimeMode: "full-access",
          })
        : await launch(studio, p);
      const history = await mcp(studio, "t3_thread_read", { threadId: source.threadId });
      const before = await mcp(studio, "t3_project_machines", { project: p.id });
      NodeAssert.ok(!before.representations.some((rep) => rep.environmentId === target.id));
      for (const instanceId of real ? ["codex", "opencode"] : ["fakeCodex", "fakeOpenCode"]) {
        const fork = await mcp(studio, "t3_thread_fork", {
          threadId: source.threadId,
          targetEnvironmentId: target.id,
          modelSelection: {
            instanceId,
            model: real
              ? instanceId === "codex"
                ? (process.env.MESH_E2E_CODEX_MODEL ?? "gpt-6-luna")
                : "deepseek/deepseek-flash"
              : "fast",
          },
          message: real
            ? "Run cat README.md in the shell. Reply with FAST_READ_BYTES followed by the exact file content. Do not guess its contents."
            : "FAST_READ",
        });
        if (real)
          await mcp(target, "t3_thread_wait", { threadId: fork.threadId, timeoutMs: 120000 });
        const read = real
          ? await mcp(target, "t3_thread_read", {
              threadId: fork.threadId,
              view: "messages",
              limit: 100,
              maxCharsPerItem: 20000,
            })
          : await completed(target, fork.threadId);
        NodeAssert.match(JSON.stringify(read), new RegExp("FAST_READ_BYTES " + marker));
        NodeAssert.equal(read.thread.providerInstanceId, instanceId);
      }
      const after = await mcp(studio, "t3_project_machines", { project: p.id });
      const rep = after.representations.find((rep) => rep.environmentId === target.id);
      NodeAssert.equal(rep.role, "replica");
      NodeAssert.equal(rep.status.state, "watching");
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(rep.path, "README.md"), "utf8"),
        marker,
      );
      NodeAssert.deepEqual(
        items(await mcp(studio, "t3_thread_read", { threadId: source.threadId })),
        items(history),
      );
    }),
  "fork-offline-atomic": (directory) =>
    fixture(
      directory,
      async (mesh) => {
        await providers(mesh);
        const [studio, target] = mesh.nodes,
          p = await project(mesh, "fork-offline"),
          source = await launch(studio, p);
        const before = await mcp(target, "t3_thread_list", { allProjects: true, limit: 100 });
        const history = await mcp(studio, "t3_thread_read", { threadId: source.threadId });
        await mesh.stop(target);
        try {
          await NodeAssert.rejects(
            mcp(studio, "t3_thread_fork", {
              threadId: source.threadId,
              targetEnvironmentId: target.id,
              modelSelection: { instanceId: "fakeCodex", model: "fast" },
            }),
            /offline|unavailable|connect|reach|failed|timed out|did not answer/i,
          );
        } finally {
          await mesh.resume(target);
        }
        NodeAssert.deepEqual(
          await mcp(target, "t3_thread_list", { allProjects: true, limit: 100 }),
          before,
        );
        NodeAssert.deepEqual(
          items(await mcp(studio, "t3_thread_read", { threadId: source.threadId })),
          items(history),
        );
        NodeAssert.ok(
          !(await mcp(studio, "t3_project_machines", { project: p.id })).representations.some(
            (rep) => rep.environmentId === target.id,
          ),
        );
        NodeAssert.ok(!(await journals(target)).some((entry) => entry.value.phase !== "committed"));
      },
      { names: ["studio", "cloudbox"] },
    ),
  "fork-pending-expiry": (directory) =>
    fixture(
      directory,
      async (mesh) => {
        await providers(mesh);
        const [studio, target] = mesh.nodes,
          p = await project(mesh, "fork-pending"),
          source = await launch(studio, p),
          peer = await receiver(studio, target),
          id = NodeCrypto.randomUUID();
        const modelSelection = { instanceId: "fakeCodex", model: "fast" };
        await mcp(peer, "t3_thread_receive_fork", {
          action: "prepare",
          forkId: id,
          logicalKey: p.key,
          modelSelection,
        });
        const staged = await mcp(peer, "t3_thread_receive_fork", {
          action: "receive",
          bundle: {
            id,
            sourceEnvironmentId: studio.id,
            sourceThreadId: source.threadId,
            sourceTitle: "source",
            sourceMachine: "studio",
            sourceLink: source.link,
            logicalKey: p.key,
            title: "Invisible pending fork",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            entries: [{ role: "user", text: "history", attachments: [] }],
          },
        });
        const threadId = staged.result.threadId;
        NodeAssert.ok(
          (await journals(target)).some(
            (entry) => entry.key === "target:" + id && entry.value.phase === "pending",
          ),
        );
        NodeAssert.ok(
          !JSON.stringify(
            await mcp(target, "t3_thread_list", { allProjects: true, limit: 100 }),
          ).includes(threadId),
        );
        await NodeAssert.rejects(
          mcp(target, "t3_thread_read", { threadId }),
          /not_found|not found|unknown/i,
        );
        await NodeAssert.rejects(
          mcp(target, "t3_thread_send", { threadId, message: "must not run" }),
          /not_found|not found|unknown/i,
        );
        await until(
          "pending fork expiry sweep",
          () => journals(target),
          (entries) => !entries.some((entry) => entry.key === "target:" + id),
          600_000 * Number(target.env.T3_MESH_TIME_SCALE) + 60_000,
        );
        await NodeAssert.rejects(
          mcp(peer, "t3_thread_receive_fork", {
            action: "commit",
            forkId: id,
            token: staged.token,
          }),
          /expired|invalid/i,
        );
        NodeAssert.ok(
          !JSON.stringify(
            await mcp(target, "t3_thread_list", { allProjects: true, limit: 100 }),
          ).includes(threadId),
        );
        await NodeFSP.writeFile(
          NodePath.join(directory, "expiry.json"),
          JSON.stringify({ threadId, invisible: true, unrunnable: true, swept: true }),
        );
      },
      { names: ["studio", "cloudbox"] },
    ),
};
