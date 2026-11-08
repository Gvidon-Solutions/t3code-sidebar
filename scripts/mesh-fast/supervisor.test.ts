// @effect-diagnostics nodeBuiltinImport:off - Exercises the real paused supervisor process and its filesystem watcher.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

it("exits a paused supervisor on SIGTERM without leaving its watcher alive", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-supervisor-"));
  const spec = NodePath.join(root, "spec.json"),
    receipt = NodePath.join(root, "receipt.json");
  await NodeFSP.writeFile(
    spec,
    JSON.stringify({ command: process.execPath, args: [], paused: true }),
  );
  const watcher = NodeFS.watch(root);
  const stopped = new Promise<void>((resolve, reject) => {
    watcher.on("change", (event, file) => {
      if (event === "change" && file === "receipt.json") resolve();
    });
    watcher.once("error", reject);
  });
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["scripts/mesh-fast/supervisor.mjs", spec, receipt],
    {
      stdio: "ignore",
      timeout: 2000,
      killSignal: "SIGKILL",
    },
  );
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  try {
    await Promise.race([
      stopped,
      exited.then((outcome) => {
        throw Error("Supervisor exited before pausing: " + JSON.stringify(outcome));
      }),
    ]);
    expect(JSON.parse(await NodeFSP.readFile(receipt, "utf8"))).toEqual({
      stopped: true,
      generation: 0,
    });
    child.kill("SIGTERM");
    expect(await exited).toEqual({ code: 0, signal: null });
  } finally {
    watcher.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
