import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const [action, base, recordPath] = process.argv.slice(2);
if (!["pause", "resume"].includes(action) || !base || !recordPath) {
  throw new Error("Usage: resilience-driver.mjs pause|resume <base> <record>");
}
const inspect = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid captured server PID");
  const args = NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  if (!args.includes("/opt/t3/dist/bin.mjs") || !args.includes(base)) {
    throw new Error("Captured process is not this container's isolated server");
  }
  const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
};
if (action === "pause") {
  const { pid } = JSON.parse(
    NodeFS.readFileSync(NodePath.join(base, "userdata/server-runtime.json"), "utf8"),
  );
  const start = inspect(pid);
  NodeFS.writeFileSync(recordPath, JSON.stringify({ pid, start }), { mode: 0o600 });
  process.kill(pid, "SIGSTOP");
} else {
  const { pid, start } = JSON.parse(NodeFS.readFileSync(recordPath, "utf8"));
  if (!start || inspect(pid) !== start) throw new Error("Captured server PID was replaced");
  process.kill(pid, "SIGCONT");
}
