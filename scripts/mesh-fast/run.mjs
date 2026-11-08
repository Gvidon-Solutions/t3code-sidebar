import { MiniMesh } from "./mesh.mjs";
import { previous } from "./previous.mjs";
import { runtimes } from "./runtimes.mjs";
import { prepare } from "./prepare.mjs";
import { prunePassed } from "./artifacts.mjs";
import { defaultJobs, ownership, assertHostLease, recoverStale } from "./lifecycle.mjs";
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
  jobs = defaultJobs(NodeOS.availableParallelism()),
  filter,
  budgetSeconds = process.env.MESH_FAST_REALISTIC === "1" ? 10800 : 360;
while (args.length) {
  const arg = args.shift();
  if (arg === "--repeat") repeat = Number(args.shift());
  else if (arg === "--jobs") jobs = Number(args.shift());
  else if (arg === "--scenario") filter = args.shift();
  else if (arg === "--budget-seconds") budgetSeconds = Number(args.shift());
  else if (arg === "--host-info") filter = "@host-info";
  else throw Error(`Unknown argument ${arg}`);
}
if (![repeat, jobs, budgetSeconds].every((n) => Number.isInteger(n) && n > 0))
  throw Error("repeat/jobs/budget-seconds must be positive integers");
const priority = [
  "bootstrap-rollout",
  "run-concept",
  "crash-laptop-mount",
  "crash-cloudbox-mount",
  "crash-studio-sync",
  "network-mid-pipe",
  "f1-pending-expiry",
  "crash-studio-mount",
  "network-sleep",
  "crash-laptop-sync",
  "replica-conflicts",
  "crash-cloudbox-sync",
  "replica-foreign-adoption",
  "f1-web-journey",
  "replica-policies",
  "cli-routing",
  "fork-matrix",
  "crash-restart-orders",
  "f1-replica-content",
  "crash-mutagen",
  "threads-fake-provider",
  "f1-dropped-commit",
  "installer-cold",
  "replica-ssh",
  "config-rules-agents",
  "replica-full",
  "replica-warnings",
  "c2-concurrent-reverse",
  "clock-skew-hour",
  "layout-alias-transports",
  "network-delay",
  "network-reset",
  "mixed-version",
  "c2-concurrent-forward",
  "network-drop-idle",
  "network-cut",
  "f1-offline-atomic",
  "network-ip-change",
  "layout-files",
  "identity-collisions-unknown-version",
  "layout-legacy-concurrent",
  "layout-path-claims",
  "layout-legacy-edits",
  "config-clock",
  "layout-partition",
  "timing-heartbeat",
  "runner-cancel-boot",
];
const selected = Object.entries(scenarios)
  .sort(([a], [b]) => {
    const x = priority.indexOf(a),
      y = priority.indexOf(b);
    return (x < 0 ? priority.length : x) - (y < 0 ? priority.length : y);
  })
  .filter(([name]) => !filter || name.includes(filter));
await assertHostLease();
const owner = await ownership();
const host = {
  ...owner,
  jobs,
  containerBoots: 2,
  serverBoots: Math.max(2, Math.min(8, Math.floor(owner.cores / 2))),
};
if (filter === "@host-info") {
  console.log(JSON.stringify(host, null, 2));
  process.exit(0);
}
if (!selected.length) throw Error(`No scenarios match ${filter}`);
const artifactsDirectory = process.env.MESH_FAST_ARTIFACTS_DIR ?? NodeOS.tmpdir();
await NodeFSP.mkdir(artifactsDirectory, { recursive: true });
const root = await NodeFSP.mkdtemp(NodePath.join(artifactsDirectory, "mesh-fast-"));
await NodeFSP.writeFile(NodePath.join(root, "runner.json"), JSON.stringify(host));
console.log(`Host: ${owner.hostname}; cores ${owner.cores}; meshes ${jobs}; container boots 2`);
console.log(`Artifacts: ${root}`);
if (process.env.GITHUB_OUTPUT)
  await NodeFSP.appendFile(process.env.GITHUB_OUTPUT, `artifacts=${root}\n`);
const started = performance.now(),
  results = [];
let recovery;
const elapsed = () => (performance.now() - started) / 1000;
const escape = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
async function report() {
  const seconds = elapsed();
  await NodeFSP.writeFile(
    NodePath.join(root, "summary.json"),
    JSON.stringify({ seconds, budgetSeconds, host, recovery, results }, null, 2),
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
  recovery = await recoverStale(owner);
  await NodeFSP.writeFile(NodePath.join(root, "recovery.json"), JSON.stringify(recovery, null, 2));
  if (recovery.interruptedRuns.length)
    console.log(
      `RECOVERED ${recovery.containers.length} containers, ${recovery.networks.length} networks from interrupted runs`,
    );
  process.env.MESH_FAST_MUTAGEN_CACHE = await prepare();
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= NodePath.join(
    process.env.MESH_FAST_MUTAGEN_CACHE,
    "browsers",
  );
  process.env.MESH_FAST_RUNTIMES = await runtimes(process.env.MESH_FAST_MUTAGEN_CACHE);
  await NodeFSP.copyFile(
    NodePath.join(process.env.MESH_FAST_RUNTIMES, "preparation.json"),
    NodePath.join(root, "preparation.json"),
  );
  if (selected.some(([name]) => name === "mixed-version"))
    process.env.MESH_FAST_PREVIOUS_ENTRY = await previous(process.env.MESH_FAST_MUTAGEN_CACHE);
  const queue = selected.flatMap(([name, run]) =>
    Array.from({ length: repeat }, (_, index) => ({ name: `${name}-${index + 1}`, run })),
  );
  async function execute(task) {
    if (terminating) return;
    const directory = NodePath.join(root, task.name);
    await NodeFSP.mkdir(directory);
    const start = performance.now();
    let error;
    try {
      await task.run(directory);
      await prunePassed(directory);
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
  // Recovery inspects ownership globally before other scenarios create or remove fixtures.
  for (const task of queue.filter((task) => task.name.startsWith("runner-reboot-recovery-")))
    await execute(task);
  const parallel = queue.filter((task) => !task.name.startsWith("runner-reboot-recovery-"));
  await Promise.all(
    Array.from({ length: Math.min(jobs, parallel.length) }, async () => {
      for (let task; (task = parallel.shift());) await execute(task);
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
