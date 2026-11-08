import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import { fixture, project, place, run, mcp } from "./helpers.mjs";
import { providers, completed } from "./threads.mjs";
import { productRoot } from "./paths.mjs";
const cli = NodePath.join(productRoot, "agent-kit/skills/t3/scripts/t3ctl.mjs");
export const cliScenarios = {
  "cli-routing": (directory) =>
    fixture(directory, async (mesh) => {
      await providers(mesh);
      const [studio, , laptop] = mesh.nodes,
        p = await project(mesh, "cli-project");
      await place(laptop, p);
      const thread = await mcp(studio, "t3_thread_launch", {
        projectId: p.id,
        title: "CLI unique thread",
        message: "FAST_WRITE:cli",
        modelSelection: { instanceId: "fakeCodex", model: "fast" },
        runtimeMode: "full-access",
      });
      await completed(studio, thread.threadId);
      const ctl = async (...args) => {
        await NodeFSP.appendFile(
          NodePath.join(directory, "cli-commands.log"),
          JSON.stringify(args) + "\n",
        );
        const result = await run(process.execPath, [cli, ...args], {
          env: {
            ...laptop.env,
            T3CODE_HOME: laptop.base,
            T3CTL_ORIGIN: laptop.origin,
            T3CTL_T3_BIN: NodePath.join(laptop.root, "runtime/t3"),
            T3CTL_ISOLATED_TEST: "1",
          },
        });
        await NodeFSP.appendFile(NodePath.join(directory, "cli-commands.log"), "PASS\n");
        return result;
      };
      NodeAssert.match(
        await ctl("cat", NodePath.join(p.root, "README.md"), "--on", studio.id),
        /cli-project/,
      );
      NodeAssert.match(await ctl("find", "CLI unique thread", "--all"), /CLI unique thread/);
      NodeAssert.ok((await ctl("status", "--all")).length);
      for (const command of [["machines"], ["mesh", "status"], ["projects"], ["replicas"]]) {
        const result = await ctl(...command);
        NodeAssert.match(result, /studio|laptop|cli-project/);
        if (command[0] === "replicas") NodeAssert.ok(!result.includes(p.key));
      }
    }),
};
