// @effect-diagnostics nodeBuiltinImport:off - Verifies the real OS lock shutdown boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { expect, it } from "vite-plus/test";
import { waitForDaemonShutdown } from "./daemons.mjs";

it("waits for the private lock after the daemon listener is already gone", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-daemon-lock-"));
  await NodeFSP.mkdir(NodePath.join(root, "daemon"));
  const child = NodeChildProcess.spawn(
    "flock",
    [
      NodePath.join(root, "daemon/daemon.lock"),
      process.execPath,
      "-e",
      `const lines=require('node:readline').createInterface({input:process.stdin});
       console.log('locked');
       lines.on('line',line=>{if(line==='probe')console.log('still-writing');else process.exit(0)});`,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const lines = NodeReadline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(Error("Lock owner: " + code))));
  });
  let writing = true;
  let waiting: Promise<void> | undefined;
  try {
    expect((await lines.next()).value).toBe("locked");
    waiting = waitForDaemonShutdown(root).then(() => {
      expect(writing).toBe(false);
    });
    // Attach the failure observer before the subprocess boundary can complete.
    const outcome = waiting.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    child.stdin.write("probe\n");
    expect((await lines.next()).value).toBe("still-writing");
    writing = false;
    child.stdin.end("finish\n");
    await exited;
    const result = await outcome;
    if (!result.ok) throw result.error;
  } finally {
    child.stdin.end("finish\n");
    await exited;
    await lines.return?.();
    await waiting;
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
