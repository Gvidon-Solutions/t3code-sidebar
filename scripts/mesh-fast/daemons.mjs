import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
import { run } from "./client.mjs";

export async function posixLockBinary(
  directory = process.env.MESH_FAST_MUTAGEN_CACHE ??
    NodePath.join(NodeOS.tmpdir(), "mesh-fast-tools-0.18.1"),
) {
  const source = new URL("posix-lock.c", import.meta.url);
  const hash = NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(source))
    .digest("hex")
    .slice(0, 16);
  await NodeFSP.mkdir(directory, { recursive: true });
  const binary = NodePath.join(directory, "posix-lock-" + hash);
  try {
    await NodeFSP.stat(binary);
    return binary;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = binary + "." + NodeCrypto.randomUUID();
  await run("cc", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    NodeURL.fileURLToPath(source),
    "-o",
    temporary,
  ]);
  await NodeFSP.rename(temporary, binary);
  return binary;
}

export async function waitForDaemonShutdown(data, cache) {
  const lock = NodePath.join(data, "daemon/daemon.lock");
  try {
    await NodeFSP.stat(lock);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const binary = await posixLockBinary(cache);
  // Mutagen uses POSIX locks, which are independent of Linux flock locks.
  await run(binary, [lock]);
}
