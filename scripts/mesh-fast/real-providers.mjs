import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeAssert from "node:assert/strict";
import { rpc } from "./helpers.mjs";
export async function realProviders(mesh) {
  NodeAssert.equal(
    process.env.MESH_FAST_REALISTIC,
    "1",
    "Paid providers belong only to the realistic suite",
  );
  for (const node of mesh.nodes) {
    await NodeFSP.mkdir(NodePath.join(node.home, ".codex"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(node.home, ".local/share/opencode"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(node.home, ".config/opencode"), { recursive: true });
    await NodeFSP.copyFile(
      NodePath.join(
        process.env.R1_CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex"),
        "auth.json",
      ),
      NodePath.join(node.home, ".codex/auth.json"),
    );
    await NodeFSP.copyFile(
      process.env.R1_OPENCODE_AUTH ??
        NodePath.join(NodeOS.homedir(), ".local/share/opencode/auth.json"),
      NodePath.join(node.home, ".local/share/opencode/auth.json"),
    );
    for (const relative of [".codex/auth.json", ".local/share/opencode/auth.json"])
      await NodeFSP.chmod(NodePath.join(node.home, relative), 0o600);
    const profiles = {};
    for (const driver of ["codex", "opencode"]) {
      const source = process.env["R1_" + driver.toUpperCase() + "_BINARY"];
      NodeAssert.ok(source, "R1_" + driver.toUpperCase() + "_BINARY is required");
      const binaryPath = NodePath.join(node.home, driver + "-native");
      await NodeFSP.copyFile(source, binaryPath);
      await NodeFSP.chmod(binaryPath, 0o700);
      profiles[driver] = {
        driver,
        enabled: true,
        config: {
          binaryPath,
          ...(driver === "codex"
            ? { setupMode: "existing", homePath: NodePath.join(node.home, ".codex") }
            : {}),
        },
        environment: [{ name: "OPENCODE_DISABLE_AUTOUPDATE", value: "1", sensitive: false }],
      };
    }
    await rpc(node, "server.updateSettings", { patch: { providerInstances: profiles } });
    await rpc(node, "server.refreshProviders", { fresh: true, refreshModels: true });
  }
}
