import { MiniMesh } from "./mesh.mjs";
import { previous } from "./previous.mjs";
import { runtimes } from "./runtimes.mjs";
import { prepare } from "./prepare.mjs";
import { prunePassed, pruneRuns, finishRun } from "./artifacts.mjs";
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
  "fork-pending-expiry",
  "crash-studio-mount",
  "network-sleep",
  "crash-laptop-sync",
  "replica-conflicts",
  "crash-cloudbox-sync",
  "replica-foreign-adoption",
  "fork-web-journey",
  "replica-policies",
  "cli-routing",
  "fork-matrix",
  "crash-restart-orders",
  "fork-replica-content",
  "crash-mutagen",
  "threads-fake-provider",
  "fork-dropped-commit",
  "installer-cold",
  "replica-ssh",
  "config-rules-agents",
  "replica-full",
  "replica-warnings",
  "machine-name-concurrent-reverse",
  "clock-skew-hour",
  "layout-alias-transports",
  "network-delay",
  "network-reset",
  "mixed-version",
  "machine-name-concurrent-forward",
  "network-drop-idle",
  "network-cut",
  "fork-offline-atomic",
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
  artifactsDirectory: NodePath.resolve(process.env.MESH_FAST_ARTIFACTS_DIR),
  cacheDirectory: NodePath.resolve(process.env.MESH_FAST_MUTAGEN_CACHE),
};
if (filter === "@host-info") {
  console.log(JSON.stringify(host, null, 2));
  process.exit(0);
}
if (!selected.length) throw Error(`No scenarios match ${filter}`);
await NodeFSP.mkdir(host.artifactsDirectory, { recursive: true });
// Fixture paths are matched against process.cwd(), which resolves symlinks. Keep the whole run
// under its real path so a symlinked artifacts directory cannot make a replica look local.
const artifactsDirectory = await NodeFSP.realpath(host.artifactsDirectory);
host.artifactsDirectory = artifactsDirectory;
const root = await NodeFSP.mkdtemp(NodePath.join(artifactsDirectory, "mesh-fast-"));
await NodeFSP.writeFile(NodePath.join(root, "runner.json"), JSON.stringify(host));
console.log(`Host: ${owner.hostname}; cores ${owner.cores}; meshes ${jobs}; container boots 2`);
console.log(`Run directory: ${root}`);
if (process.env.GITHUB_OUTPUT)
  await NodeFSP.appendFile(process.env.GITHUB_OUTPUT, `artifacts=${root}\n`);
const started = performance.now(),
  results = [];
let recovery;
let pruning;
const elapsed = () => (performance.now() - started) / 1000;
const escape = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
async function report(directory) {
  const seconds = elapsed();
  await NodeFSP.writeFile(
    NodePath.join(directory, "summary.json"),
    JSON.stringify({ seconds, budgetSeconds, host, recovery, results }, null, 2),
  );
  await NodeFSP.writeFile(
    NodePath.join(directory, "junit.xml"),
    `<testsuite name="mesh-fast" tests="${results.length}" failures="${results.filter((r) => r.error).length}" time="${seconds}">${results.map((r) => `<testcase name="${escape(r.name)}" time="${r.seconds}">${r.error ? `<failure message="scenario failed">${escape(r.error)}</failure>` : ""}</testcase>`).join("")}</testsuite>\n`,
  );
}
let completion;
function finish(failed) {
  completion ??= (async () => {
    await pruning;
    await report(root);
    const artifacts = await finishRun(root, owner, failed);
    await report(artifacts);
    console.log(`Artifacts: ${artifacts}`);
    if (process.env.GITHUB_OUTPUT)
      await NodeFSP.appendFile(process.env.GITHUB_OUTPUT, `artifacts=${artifacts}\n`);
    console.log(
      `${results.filter((r) => !r.error).length}/${results.length} passed; wall ${elapsed().toFixed(2)}s`,
    );
  })();
  return completion;
}
let terminating = false;
function assertRunning() {
  if (terminating) throw Error("Mesh runner is shutting down");
}
async function terminate(reason, code) {
  if (terminating) return;
  terminating = true;
  results.push({ name: "runner", seconds: elapsed(), error: reason });
  console.error(reason);
  const closed = await Promise.allSettled([...MiniMesh.active].map((mesh) => mesh.close()));
  for (const result of closed) if (result.status === "rejected") console.error(result.reason);
  await finish(true);
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
  assertRunning();
  pruning = pruneRuns(artifactsDirectory, owner);
  await pruning;
  assertRunning();
  await NodeFSP.writeFile(NodePath.join(root, "recovery.json"), JSON.stringify(recovery, null, 2));
  if (recovery.interruptedRuns.length)
    console.log(
      `RECOVERED ${recovery.containers.length} containers, ${recovery.networks.length} networks from interrupted runs`,
    );
  process.env.MESH_FAST_MUTAGEN_CACHE = await prepare();
  assertRunning();
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= NodePath.join(
    process.env.MESH_FAST_MUTAGEN_CACHE,
    "browsers",
  );
  process.env.MESH_FAST_RUNTIMES = await runtimes(process.env.MESH_FAST_MUTAGEN_CACHE);
  assertRunning();
  await NodeFSP.copyFile(
    NodePath.join(process.env.MESH_FAST_RUNTIMES, "preparation.json"),
    NodePath.join(root, "preparation.json"),
  );
  if (selected.some(([name]) => name === "mixed-version"))
    process.env.MESH_FAST_PREVIOUS_ENTRY = await previous(process.env.MESH_FAST_MUTAGEN_CACHE);
  assertRunning();
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
  if (!terminating) {
    results.push({ name: "infrastructure", seconds: elapsed(), error });
    await NodeFSP.writeFile(NodePath.join(root, "failure.txt"), error);
  }
  console.error(error);
} finally {
  clearTimeout(watchdog);
}
const failed = results.some((r) => r.error) || elapsed() > budgetSeconds;
await finish(failed);
process.exitCode = failed || elapsed() > budgetSeconds ? 1 : 0;
