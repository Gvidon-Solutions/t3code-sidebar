import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
const [spec, receipt] = process.argv.slice(2);
let child,
  watcher,
  stopping = false,
  generation = 0;
function start() {
  if (stopping) return;
  const { command, args, paused } = JSON.parse(NodeFS.readFileSync(spec, "utf8"));
  if (paused) {
    NodeFS.writeFileSync(receipt, JSON.stringify({ stopped: true, generation }));
    const active = NodeFS.watch(spec, () => {
      if (watcher !== active) return;
      if (!JSON.parse(NodeFS.readFileSync(spec, "utf8")).paused) {
        active.close();
        watcher = undefined;
        start();
      }
    });
    watcher = active;
    return;
  }
  child = NodeChildProcess.spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", (error) => {
    process.stderr.write(error.stack + "\n");
    process.exitCode = 1;
  });
  child.once("spawn", () => {
    NodeFS.writeFileSync(
      receipt + ".tmp",
      JSON.stringify({ pid: child.pid, generation: ++generation }),
    );
    NodeFS.renameSync(receipt + ".tmp", receipt);
  });
  child.once("exit", () => {
    if (!stopping) setTimeout(start, 50);
  });
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopping = true;
    watcher?.close();
    watcher = undefined;
    if (child?.exitCode === null) {
      const graceful =
        process.env.MESH_FAST_REALISTIC === "1" ||
        JSON.parse(NodeFS.readFileSync(spec, "utf8")).args.includes("__service-launcher");
      child.kill("SIGCONT");
      child.kill(graceful ? "SIGTERM" : "SIGKILL");
      if (graceful) setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }
  });
start();
