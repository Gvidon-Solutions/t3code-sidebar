import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { run } from "./client.mjs";

async function waitForLock(lock) {
  try {
    await NodeFSP.stat(lock);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await run("flock", ["--wait", "30", lock, "true"]);
}

export const waitForDaemonShutdown = (data) =>
  waitForLock(NodePath.join(data, "daemon/daemon.lock"));
export const waitForSshShutdown = (home) => waitForLock(NodePath.join(home, "sshd/sessions.lock"));
