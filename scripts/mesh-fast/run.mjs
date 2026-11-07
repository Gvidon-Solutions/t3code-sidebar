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
  jobs = 2,
  filter;
while (args.length) {
  const arg = args.shift();
  if (arg === "--repeat") repeat = Number(args.shift());
  else if (arg === "--jobs") jobs = Number(args.shift());
  else if (arg === "--scenario") filter = args.shift();
  else throw Error(`Unknown argument ${arg}`);
}
if (![repeat, jobs].every((n) => Number.isInteger(n) && n > 0))
  throw Error("repeat/jobs must be positive integers");
const selected = Object.entries(scenarios).filter(([name]) => !filter || name.includes(filter));
if (!selected.length) throw Error(`No scenarios match ${filter}`);
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-fast-"));
console.log(`Artifacts: ${root}`);
const started = performance.now(),
  results = [];
const queue = Array.from({ length: repeat }, (_, index) =>
  selected.map(([name, run]) => ({ name: `${name}-${index + 1}`, run })),
).flat();
await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let task; (task = queue.shift());) {
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
const seconds = (performance.now() - started) / 1000;
const escape = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
await NodeFSP.writeFile(
  NodePath.join(root, "junit.xml"),
  `<testsuite name="mesh-fast" tests="${results.length}" failures="${results.filter((r) => r.error).length}" time="${seconds}">${results.map((r) => `<testcase name="${escape(r.name)}" time="${r.seconds}">${r.error ? `<failure message="scenario failed">${escape(r.error)}</failure>` : ""}</testcase>`).join("")}</testsuite>\n`,
);
await NodeFSP.writeFile(
  NodePath.join(root, "summary.json"),
  JSON.stringify({ seconds, results }, null, 2),
);
console.log(
  `${results.filter((r) => !r.error).length}/${results.length} passed; wall ${seconds.toFixed(2)}s`,
);
process.exitCode = results.some((r) => r.error) || seconds > 300 ? 1 : 0;
