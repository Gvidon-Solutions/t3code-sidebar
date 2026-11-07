import * as NodeFSP from "node:fs/promises";
import * as NodeAssert from "node:assert/strict";
import { fixture, rpc, until } from "./helpers.mjs";
export const skewScenarios = {
  "clock-skew-hour": (directory) =>
    fixture(
      directory,
      async (mesh) => {
        const [studio, hub] = mesh.nodes;
        const before = await rpc(studio, "meshLayout.get");
        await NodeFSP.writeFile(studio.env.MESH_FAST_CLOCK_FILE, "3600000");
        try {
          await rpc(studio, "server.updateSettings", {
            patch: {
              sidebarWorkspaces: {
                ...before.config,
                workspaces: [
                  ...before.config.workspaces,
                  { id: "skew-workspace", name: "skew-workspace" },
                ],
              },
            },
          });
          await until(
            "receiver reports skew rejection",
            () => rpc(hub, "meshLayout.status"),
            (value) => value.clockRejections?.some((row) => row.count > 0),
          );
          NodeAssert.ok(
            !(await rpc(hub, "meshLayout.get")).config.workspaces.some(
              (ws) => ws.id === "skew-workspace",
            ),
          );
        } finally {
          await NodeFSP.writeFile(studio.env.MESH_FAST_CLOCK_FILE, "0");
        }
        await mesh.restart(studio);
        NodeAssert.ok(
          !(await rpc(studio, "meshLayout.get")).config.workspaces.some(
            (ws) => ws.id === "skew-workspace",
          ),
        );
      },
      { skewable: true },
    ),
};
