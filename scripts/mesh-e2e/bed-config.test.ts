// @effect-diagnostics nodeBuiltinImport:off - Exercises real isolated shell processes and result files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";
const execute = NodeUtil.promisify(NodeChildProcess.execFile);
it("routes bed roles through the configured inventory and pins both SSH destinations", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bed-inventory-"));
  try {
    for (const name of ["lib.sh", "bed-config.sh"])
      await NodeFSP.copyFile(NodePath.join(import.meta.dirname, name), NodePath.join(root, name));
    await NodeFSP.writeFile(NodePath.join(root, "ssh"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
      mode: 0o700,
    });
    const { stdout } = await execute(
      "bash",
      [
        "-c",
        'source "$1"; printf "%s\\n" "${BED_MACHINES[@]}"; worker_ssh probe; cloudbox_ssh probe; printf "%s\\n" "$NODE_A_LOCAL" "$NODE_A_RUNTIME_ROOT" "$NODE_B_RUNTIME_ROOT" "$NODE_A_TUNNEL_UNIT" "$NODE_B_TUNNEL_UNIT"',
        "bed-config",
        NodePath.join(root, "lib.sh"),
      ],
      {
        env: {
          ...process.env,
          PATH: root + NodePath.delimiter + process.env.PATH,
          NODE_B_HOST: "studio.test",
          NODE_A_LOCAL: "13995",
          NODE_A_RUNTIME_ROOT: "/private/controller-runtime",
          NODE_B_RUNTIME_ROOT: "/private/worker-runtime",
          NODE_A_TUNNEL_UNIT: "t3-mesh-e2e-studio-forward.service",
          NODE_B_TUNNEL_UNIT: "t3-mesh-e2e-worker-forward.service",
          CLOUD_KNOWN_HOSTS: "/private/known-hosts",
          CLOUD_SSH_USER: "bed",
          NODE_A_PUBLIC_IP: "192.0.2.1",
          NODE_B_PUBLIC_IP: "192.0.2.2",
          NODE_A_NODE_BIN_DIR: root,
          NODE_B_NODE_BIN_DIR: root,
          NODE_B_STATE_DIR: "/private/worker",
          NODE_B_DEMO_DIR: "/private/worker/projects/demo",
          CLOUD_DIR: "/private/cloud",
          CLOUD_HOST: "cloudbox.test",
          NODE_B_SSH_CONFIG: "/private/worker-config",
          NODE_B_SSH_KEY: "/private/worker-key",
          CLOUD_SSH_CONFIG: "/private/cloud-config",
        },
      },
    );
    expect(stdout.split("\n").slice(0, 3)).toEqual(["studio", "worker", "cloudbox"]);
    for (const value of [
      "13995",
      "/private/controller-runtime",
      "/private/worker-runtime",
      "t3-mesh-e2e-studio-forward.service",
      "t3-mesh-e2e-worker-forward.service",
      "studio.test",
      "cloudbox.test",
      "/private/worker-config",
      "/private/worker-key",
      "/private/cloud-config",
      "StrictHostKeyChecking=yes",
      "UpdateHostKeys=no",
    ])
      expect(stdout).toContain(value);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
