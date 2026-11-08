import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { run } from "./client.mjs";

export async function waitForDaemonShutdown(data) {
  const lock = NodePath.join(data, "daemon/daemon.lock");
  try {
    await NodeFSP.stat(lock);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  // Mutagen closes its listener before it finishes writing caches and releases its lock.
  await run("flock", ["--wait", "30", lock, "true"]);
}
