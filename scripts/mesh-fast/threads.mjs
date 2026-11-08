import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { fixture, project, rpc, mcp, until, content } from "./helpers.mjs";
const agent = NodeURL.fileURLToPath(new URL("fake-agent.mjs", import.meta.url));
const instances = ["fakeCodex", "fakeOpenCode"];
export async function providers(mesh) {
  await Promise.all(
    mesh.nodes.map(async (node) => {
      await rpc(node, "server.updateSettings", {
        patch: {
          providerInstances: {
            ...node.inactiveProviders,
            ...Object.fromEntries(
              instances.map((instanceId) => [
                instanceId,
                {
                  driver: "acpRegistry",
                  enabled: true,
                  displayName: instanceId,
                  config: {
                    source: "local",
                    commandPath: node.container ? "/usr/local/bin/node" : process.execPath,
                    commandArgs: [agent],
                  },
                },
              ]),
            ),
          },
        },
      });
      await rpc(node, "server.refreshProviders", { fresh: true, refreshModels: true });
    }),
  );
}
export async function completed(node, threadId) {
  await mcp(node, "t3_thread_wait", { threadId, timeoutMs: 60000 });
  const result = await mcp(node, "t3_thread_read", {
    threadId,
    view: "messages",
    limit: 100,
    maxCharsPerItem: 20000,
  });
  NodeAssert.match(JSON.stringify(result), /FAST_DONE/);
  return result;
}
export const threadScenarios = {
  "threads-fake-provider": (directory) =>
    fixture(directory, async (mesh) => {
      await providers(mesh);
      const [studio, , laptop] = mesh.nodes,
        p = await project(mesh, "agent");
      const request = {
        projectId: p.id,
        environmentId: laptop.id,
        clientRequestId: "fast-idempotent-launch",
        title: "fast-idempotent",
        message: "FAST_WRITE:replica-edit FAST_SELF",
        modelSelection: { instanceId: "fakeCodex", model: "fast" },
        runtimeMode: "full-access",
      };
      const first = await mcp(studio, "t3_thread_launch", request),
        again = await mcp(studio, "t3_thread_launch", request);
      NodeAssert.equal(first.threadId, again.threadId);
      await completed(laptop, first.threadId);
      await content(NodePath.join(p.root, "README.md"), "agent\nreplica-edit");
      const self = await mcp(laptop, "t3_thread_read", { threadId: first.threadId });
      NodeAssert.ok(self.thread.projectId);
      NodeAssert.match(JSON.stringify(self), /FAST_SELF_JSON/);
      NodeAssert.match(JSON.stringify(self), /replica/);
      await mcp(studio, "t3_thread_send", {
        threadId: first.threadId,
        message: "FAST_WRITE:remote-send",
      });
      await completed(laptop, first.threadId);
      await until(
        "remote send synced",
        () => NodeFSP.readFile(NodePath.join(p.root, "README.md"), "utf8"),
        (value) => value.includes("remote-send"),
      );
      NodeAssert.ok(
        JSON.stringify(
          await mcp(studio, "t3_thread_list", { environmentId: "all", limit: 100 }),
        ).includes(first.threadId),
      );
      await NodeAssert.rejects(
        mcp(laptop, "t3_thread_move", {
          threadId: first.threadId,
          projectId: p.id,
          environmentId: laptop.id,
        }),
        /machine|fork|environment|move|project|not_found/i,
      );
    }),
  "fork-matrix": (directory) =>
    fixture(directory, async (mesh) => {
      await providers(mesh);
      const [studio] = mesh.nodes,
        p = await project(mesh, "fork");
      const source = await mcp(studio, "t3_thread_launch", {
        projectId: p.id,
        title: "fork-source",
        message: "FAST_WRITE:source",
        modelSelection: { instanceId: "fakeCodex", model: "fast" },
        runtimeMode: "full-access",
      });
      const history = await completed(studio, source.threadId);
      for (const target of mesh.nodes)
        for (const instanceId of instances) {
          const fork = await mcp(studio, "t3_thread_fork", {
            threadId: source.threadId,
            targetEnvironmentId: target.id,
            modelSelection: { instanceId, model: "fast" },
          });
          NodeAssert.notEqual(fork.threadId, source.threadId);
          const read = await mcp(target, "t3_thread_read", {
            threadId: fork.threadId,
            view: "messages",
            limit: 100,
          });
          NodeAssert.match(JSON.stringify(read), /FAST_DONE source/);
          NodeAssert.match(JSON.stringify(read), /fork/i);
        }
      const after = await mcp(studio, "t3_thread_read", {
        threadId: source.threadId,
        view: "messages",
        limit: 100,
        maxCharsPerItem: 20000,
      });
      NodeAssert.deepEqual(
        after.items.map(({ updatedAt: _updatedAt, ...item }) => item),
        history.items.map(({ updatedAt: _updatedAt, ...item }) => item),
      );
      await mcp(studio, "t3_thread_send", { threadId: source.threadId, message: "FAST_HOLD" });
      await until(
        "source has active partial turn",
        () =>
          mcp(studio, "t3_thread_read", {
            threadId: source.threadId,
            view: "messages",
            limit: 100,
          }),
        (value) => value.thread.activeRunId !== null,
      );
      await content(NodePath.join(p.root, ".t3/hold-ready"), "ready");
      const target = mesh.nodes[2];
      try {
        const fork = await mcp(studio, "t3_thread_fork", {
          threadId: source.threadId,
          targetEnvironmentId: target.id,
          modelSelection: { instanceId: "fakeOpenCode", model: "fast" },
        });
        const copied = JSON.stringify(
          await mcp(target, "t3_thread_read", {
            threadId: fork.threadId,
            view: "messages",
            limit: 100,
          }),
        );
        NodeAssert.match(copied, /FAST_DONE source/);
        NodeAssert.doesNotMatch(copied, /IN_PROGRESS|FAST_HOLD/);
      } finally {
        await NodeFSP.writeFile(NodePath.join(p.root, ".fast-release"), "release");
      }
      await completed(studio, source.threadId);
      const other = await project(mesh, "move-target");
      const idle = await mcp(studio, "t3_thread_launch", {
        projectId: p.id,
        title: "idle",
        modelSelection: { instanceId: "fakeCodex", model: "fast" },
      });
      await mcp(studio, "t3_thread_move", { threadId: idle.threadId, projectId: other.id });
      NodeAssert.equal(
        (await mcp(studio, "t3_thread_read", { threadId: idle.threadId })).thread.projectId,
        other.id,
      );
    }),
};
