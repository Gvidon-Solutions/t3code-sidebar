import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
const [spec, receipt] = process.argv.slice(2);
let child,
  stopping = false,
  generation = 0;
function start() {
  const { command, args, paused } = JSON.parse(NodeFS.readFileSync(spec, "utf8"));
  if (paused) {
    NodeFS.writeFileSync(receipt, JSON.stringify({ stopped: true, generation }));
    const watcher = NodeFS.watch(spec, () => {
      if (!JSON.parse(NodeFS.readFileSync(spec, "utf8")).paused) {
        watcher.close();
        start();
      }
    });
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
    if (child?.exitCode === null) {
      child.kill("SIGCONT");
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }
  });
start();
