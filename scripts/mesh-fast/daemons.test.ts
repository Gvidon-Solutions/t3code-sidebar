// @effect-diagnostics nodeBuiltinImport:off - Verifies the real OS lock shutdown boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { expect, it } from "vite-plus/test";
import { waitForDaemonShutdown, waitForSshShutdown } from "./daemons.mjs";

it.each([
  { label: "daemon", lock: "daemon/daemon.lock", shared: false, wait: waitForDaemonShutdown },
  { label: "SSH session", lock: "sshd/sessions.lock", shared: true, wait: waitForSshShutdown },
])("waits for the private $label lock after its listener is already gone", async (fixture) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-daemon-lock-"));
  await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, fixture.lock)));
  const child = NodeChildProcess.spawn(
    "flock",
    [
      ...(fixture.shared ? ["--shared"] : []),
      NodePath.join(root, fixture.lock),
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
    waiting = fixture.wait(root).then(() => {
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
