import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
import { fixture, project, mcp, run, rpc } from "./helpers.mjs";
import { providers, completed } from "./threads.mjs";
const repo = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
export const uiScenarios = {
  "fork-web-journey": (directory) =>
    fixture(
      directory,
      async (mesh) => {
        await providers(mesh);
        const [studio, empty] = mesh.nodes,
          p = await project(mesh, "fork-source"),
          target = await project(mesh, "fork-target");
        await rpc(studio, "meshLayout.apply", {
          entries: Object.fromEntries(
            Object.entries({
              "ws/main": { name: "main", sort: "a0" },
              "ws.default": "main",
              ["place/" + p.key + "/main"]: { sort: "a0" },
              ["place/" + target.key + "/main"]: { sort: "a1" },
            }).map(([key, v]) => [key, { v, h: `${Date.now()}.00000.${studio.id}` }]),
          ),
        });
        const thread = await mcp(studio, "t3_thread_launch", {
          projectId: p.id,
          title: "Fork drag with history",
          message: "FAST_WRITE:ui-history",
          modelSelection: { instanceId: "fakeCodex", model: "fast" },
          runtimeMode: "full-access",
        });
        await completed(studio, thread.threadId);
        await rpc(empty, "server.updateSettings", {
          patch: {
            providerInstances: {
              ...empty.inactiveProviders,
              fakeCodex: { driver: "acpRegistry", enabled: false },
              fakeOpenCode: { driver: "acpRegistry", enabled: false },
            },
          },
        });
        await rpc(empty, "server.refreshProviders", { fresh: true, refreshModels: true });
        const pair = JSON.parse(
          await studio.cli(["auth", "pairing", "create", "--ttl", "10m", "--json"]),
        );
        const { request } = await import("playwright-core");
        const auth = await request.newContext();
        const artifacts = NodePath.join(directory, "artifacts"),
          storage = NodePath.join(artifacts, "auth.json");
        try {
          const response = await auth.post(studio.origin + "/api/auth/browser-session", {
            data: { credential: pair.credential },
          });
          NodeAssert.ok(response.ok(), await response.text());
          await auth.storageState({ path: storage });
          await NodeFSP.chmod(storage, 0o600);
        } finally {
          await auth.dispose();
        }
        const cli = NodePath.join(artifacts, "t3");
        await NodeFSP.writeFile(
          cli,
          `#!/bin/sh\nexec '/usr/local/bin/node' '${NodePath.join(repo, "apps/server/src/bin.ts")}' "$@"\n`,
          { mode: 0o700 },
        );
        const env = {
          ...studio.env,
          PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
          T3CODE_HOME: studio.base,
          T3CTL_ORIGIN: studio.origin,
          T3CTL_T3_BIN: cli,
        };
        await run("docker", [
          "exec",
          "-u",
          "node",
          ...Object.entries(env).flatMap(([key, value]) => ["-e", key + "=" + value]),
          studio.container,
          "/usr/local/bin/node",
          NodePath.join(repo, "scripts/mesh-e2e/fork-web.mjs"),
          "--origin",
          studio.origin,
          "--storage-state",
          storage,
          "--thread-title",
          "Fork drag with history",
          "--thread-id",
          thread.threadId,
          "--target-title",
          target.title,
          "--target-project-id",
          target.id,
          "--remote-machine",
          "laptop",
          "--empty-machine",
          "cloudbox",
          "--shots",
          NodePath.join(artifacts, "shots"),
        ]);
      },
      { browser: true },
    ),
};
