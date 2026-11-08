// @effect-diagnostics nodeBuiltinImport:off - Exercises the real host admission lock and subprocess lifecycle.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";
import { defaultJobs } from "./lifecycle.mjs";

it("admits one host gate, releases a terminated owner, and caps the local default at eight", async () => {
  const state = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-host-lease-"));
  const env = { ...process.env, MESH_FAST_STATE_DIR: state };
  const holder = NodeChildProcess.spawn(
    "bash",
    [
      "-ec",
      'exec 9>"$MESH_FAST_STATE_DIR/host.lock"; flock --nonblock 9; exec "$1" -e \'console.log("locked"); process.stdin.resume()\'',
      "lease",
      process.execPath,
    ],
    { env, stdio: ["pipe", "pipe", "inherit"] },
  );
  const lines = NodeReadline.createInterface({ input: holder.stdout })[Symbol.asyncIterator]();
  const closed = new Promise<void>((resolve, reject) => {
    holder.once("error", reject);
    holder.once("close", (code, signal) =>
      code === 0 || signal === "SIGKILL" ? resolve() : reject(Error("Lease owner: " + code)),
    );
  });
  const exec = NodeUtil.promisify(NodeChildProcess.execFile);
  try {
    expect((await lines.next()).value).toBe("locked");
    for (const entry of ["scripts/mesh-fast/run.sh", "scripts/mesh-fast/setup.sh"])
      await expect(exec("bash", [entry, "--host-info"], { env })).rejects.toMatchObject({
        code: 75,
        stderr: expect.stringContaining("host admission lock"),
      });
    holder.kill("SIGKILL");
    await closed;
    const result = await exec("bash", ["scripts/mesh-fast/run.sh", "--host-info"], { env });
    const host: { hostname: string; cores: number; jobs: number; containerBoots: number } =
      JSON.parse(result.stdout);
    expect(host.hostname).toBe(NodeOS.hostname());
    expect(host.jobs).toBe(defaultJobs(host.cores));
    expect(host.jobs).toBeLessThanOrEqual(8);
    expect(host.containerBoots).toBe(2);
    expect([1, 4, 16, 32, 128].map(defaultJobs)).toEqual([1, 1, 4, 8, 8]);
    const directEnv: NodeJS.ProcessEnv = { ...env };
    delete directEnv.MESH_FAST_HOST_LEASE_FD;
    await expect(
      exec(process.execPath, ["scripts/mesh-fast/run.mjs", "--host-info"], { env: directEnv }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("through run.sh") });
  } finally {
    holder.stdin.end();
    await closed;
    await lines.return?.();
    await NodeFSP.rm(state, { recursive: true, force: true });
  }
});
