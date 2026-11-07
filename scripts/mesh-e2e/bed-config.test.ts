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
    await NodeFSP.writeFile(NodePath.join(root, "ssh"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
      mode: 0o700,
    });
    const { stdout } = await execute(
      "bash",
      [
        "-c",
        'source "$1"; printf "%s\\n" "${BED_MACHINES[@]}"; worker_ssh probe; cloudbox_ssh probe',
        "bed-config",
        NodePath.join(import.meta.dirname, "lib.sh"),
      ],
      {
        env: {
          ...process.env,
          PATH: root + NodePath.delimiter + process.env.PATH,
          WORKER_HOST: "studio.test",
          CLOUDBOX_HOST: "cloudbox.test",
          WORKER_SSH_CONFIG: "/private/worker-config",
          WORKER_SSH_KEY: "/private/worker-key",
          CLOUDBOX_SSH_CONFIG: "/private/cloud-config",
        },
      },
    );
    expect(stdout.split("\n").slice(0, 3)).toEqual(["studio", "worker", "cloudbox"]);
    for (const value of [
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
