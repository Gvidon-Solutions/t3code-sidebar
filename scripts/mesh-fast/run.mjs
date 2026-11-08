import { MiniMesh } from "./mesh.mjs";
import { previous } from "./previous.mjs";
import { runtimes } from "./runtimes.mjs";
import { prepare } from "./prepare.mjs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { scenarios } from "./scenarios.mjs";
const inheritedPaths = new Set([process.env.T3CODE_RUN_SHIMS, process.env.T3CODE_RUN_BIN]);
process.env.PATH = (process.env.PATH ?? "")
  .split(NodePath.delimiter)
  .filter((entry) => !inheritedPaths.has(entry))
  .join(NodePath.delimiter);
for (const key of Object.keys(process.env))
  if (
    key.startsWith("T3CODE_RUN_") ||
    key.startsWith("T3_MESH_") ||
    key === "BASH_ENV" ||
    key === "ZDOTDIR"
  )
    delete process.env[key];
const args = process.argv.slice(2);
let repeat = 1,
  jobs = Math.min(16, Math.max(1, Math.floor(NodeOS.availableParallelism() / 4))),
  filter,
  budgetSeconds = process.env.MESH_FAST_REALISTIC === "1" ? 10800 : 300;
while (args.length) {
  const arg = args.shift();
  if (arg === "--repeat") repeat = Number(args.shift());
  else if (arg === "--jobs") jobs = Number(args.shift());
  else if (arg === "--scenario") filter = args.shift();
  else if (arg === "--budget-seconds") budgetSeconds = Number(args.shift());
  else throw Error(`Unknown argument ${arg}`);
}
if (![repeat, jobs, budgetSeconds].every((n) => Number.isInteger(n) && n > 0))
  throw Error("repeat/jobs/budget-seconds must be positive integers");
const priority = [
  "run-concept",
  "bootstrap-rollout",
  "cli-routing",
  "replica-policies",
  "replica-conflicts",
  "replica-foreign-adoption",
  "f1-web-journey",
  "crash-restart-orders",
  "network-mid-pipe",
  "network-sleep",
  "f1-pending-expiry",
  "fork-matrix",
  "crash-mutagen",
  "f1-replica-content",
  "c2-concurrent-forward",
  "c2-concurrent-reverse",
  "crash-studio-mount",
  "crash-cloudbox-mount",
  "crash-laptop-mount",
  "crash-studio-sync",
  "crash-cloudbox-sync",
  "crash-laptop-sync",
];
const selected = Object.entries(scenarios)
  .sort(([a], [b]) => {
    const x = priority.indexOf(a),
      y = priority.indexOf(b);
    return (x < 0 ? priority.length : x) - (y < 0 ? priority.length : y);
  })
  .filter(([name]) => !filter || name.includes(filter));
if (!selected.length) throw Error(`No scenarios match ${filter}`);
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-fast-"));
await NodeFSP.writeFile(NodePath.join(root, "runner.json"), JSON.stringify({ pid: process.pid }));
console.log(`Artifacts: ${root}`);
if (process.env.GITHUB_OUTPUT)
  await NodeFSP.appendFile(process.env.GITHUB_OUTPUT, `artifacts=${root}\n`);
const started = performance.now(),
  results = [];
const elapsed = () => (performance.now() - started) / 1000;
const escape = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
async function report() {
  const seconds = elapsed();
  await NodeFSP.writeFile(
    NodePath.join(root, "summary.json"),
    JSON.stringify({ seconds, budgetSeconds, results }, null, 2),
  );
  await NodeFSP.writeFile(
    NodePath.join(root, "junit.xml"),
    `<testsuite name="mesh-fast" tests="${results.length}" failures="${results.filter((r) => r.error).length}" time="${seconds}">${results.map((r) => `<testcase name="${escape(r.name)}" time="${r.seconds}">${r.error ? `<failure message="scenario failed">${escape(r.error)}</failure>` : ""}</testcase>`).join("")}</testsuite>\n`,
  );
  console.log(
    `${results.filter((r) => !r.error).length}/${results.length} passed; wall ${seconds.toFixed(2)}s`,
  );
}
let terminating = false;
async function terminate(reason, code) {
  if (terminating) return;
  terminating = true;
  results.push({ name: "runner", seconds: elapsed(), error: reason });
  console.error(reason);
  const closed = await Promise.allSettled([...MiniMesh.active].map((mesh) => mesh.close()));
  for (const result of closed) if (result.status === "rejected") console.error(result.reason);
  await report();
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => terminate(signal, signal === "SIGINT" ? 130 : 143));
const watchdog = setTimeout(
  () => terminate(`Wall clock budget ${budgetSeconds}s exceeded`, 1),
  budgetSeconds * 1000,
);
try {
  process.env.MESH_FAST_MUTAGEN_CACHE = await prepare();
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= NodePath.join(
    process.env.MESH_FAST_MUTAGEN_CACHE,
    "browsers",
  );
  process.env.MESH_FAST_RUNTIMES = await runtimes(process.env.MESH_FAST_MUTAGEN_CACHE);
  if (selected.some(([name]) => name === "mixed-version"))
    process.env.MESH_FAST_PREVIOUS_ENTRY = await previous(process.env.MESH_FAST_MUTAGEN_CACHE);
  const queue = selected.flatMap(([name, run]) =>
    Array.from({ length: repeat }, (_, index) => ({ name: `${name}-${index + 1}`, run })),
  );
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      for (let task; (task = queue.shift());) {
        if (terminating) return;
        const directory = NodePath.join(root, task.name);
        await NodeFSP.mkdir(directory);
        const start = performance.now();
        let error;
        try {
          await task.run(directory);
        } catch (cause) {
          error = cause.stack ?? String(cause);
          await NodeFSP.writeFile(NodePath.join(directory, "failure.txt"), error);
        }
        const seconds = (performance.now() - start) / 1000;
        results.push({ name: task.name, seconds, error });
        console.log(
          `${error ? "FAIL" : "PASS"} ${task.name} ${seconds.toFixed(2)}s${error ? `\n${error}` : ""}`,
        );
      }
    }),
  );
} catch (cause) {
  const error = cause.stack ?? String(cause);
  results.push({ name: "infrastructure", seconds: elapsed(), error });
  await NodeFSP.writeFile(NodePath.join(root, "failure.txt"), error);
  console.error(error);
} finally {
  clearTimeout(watchdog);
}
await report();
process.exitCode = results.some((r) => r.error) || elapsed() > budgetSeconds ? 1 : 0;
