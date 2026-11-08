// @effect-diagnostics nodeBuiltinImport:off - Verifies the real OS lock shutdown boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";
import { waitForDaemonShutdown } from "./daemons.mjs";

it("waits for Mutagen's POSIX lock after its listener is already gone", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-daemon-lock-"));
  await NodeFSP.mkdir(NodePath.join(root, "daemon"));
  const lock = NodePath.join(root, "daemon/daemon.lock");
  await NodeFSP.writeFile(lock, "");
  const source = NodePath.join(root, "owner.c");
  const binary = NodePath.join(root, "owner");
  await NodeFSP.writeFile(
    source,
    `
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 2) return 64;
  int fd = open(argv[1], O_RDWR);
  struct flock lock = {.l_type = F_WRLCK, .l_whence = SEEK_SET};
  if (fd < 0 || fcntl(fd, F_SETLK, &lock) < 0) return 1;
  puts("locked"); fflush(stdout);
  char line[64];
  while (fgets(line, sizeof(line), stdin)) {
    if (strcmp(line, "probe\\n") != 0) return 0;
    puts("still-writing"); fflush(stdout);
  }
  return 0;
}`,
  );
  await NodeUtil.promisify(NodeChildProcess.execFile)("cc", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    source,
    "-o",
    binary,
  ]);
  const child = NodeChildProcess.spawn(binary, [lock], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = NodeReadline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(Error("Lock owner: " + code))));
  });
  let writing = true;
  let waiting: Promise<void> | undefined;
  const receipt = lock + ".shutdown-wait.json";
  const watcher = NodeFS.watch(NodePath.dirname(lock));
  const attempting = new Promise<void>((resolve, reject) => {
    watcher.on("change", (_event, name) => {
      if (name === NodePath.basename(receipt)) resolve();
    });
    watcher.once("error", reject);
  });
  try {
    expect((await lines.next()).value).toBe("locked");
    waiting = waitForDaemonShutdown(root, root).then(() => {
      expect(writing).toBe(false);
    });
    // Attach the failure observer before the subprocess boundary can complete.
    const outcome = waiting.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await Promise.race([
      attempting,
      outcome.then((result) => {
        if (!result.ok) throw result.error;
        throw Error("Shutdown returned before attempting the POSIX lock");
      }),
    ]);
    child.stdin.write("probe\n");
    expect((await lines.next()).value).toBe("still-writing");
    writing = false;
    child.stdin.end("finish\n");
    await exited;
    const result = await outcome;
    if (!result.ok) throw result.error;
    expect(JSON.parse(await NodeFSP.readFile(receipt, "utf8")).lockType).toBe("POSIX");
  } finally {
    watcher.close();
    child.stdin.end("finish\n");
    await exited;
    await lines.return?.();
    await waiting;
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
