import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { run } from "./client.mjs";
import { ownerIsActive } from "./lifecycle.mjs";

const completeMarker = ".mesh-fast-complete.json";
const compactFiles = [
  "summary.json",
  "junit.xml",
  "runner.json",
  "recovery.json",
  "preparation.json",
];

async function regularJson(file, uid) {
  try {
    const stat = await NodeFSP.lstat(file);
    if (!stat.isFile() || stat.uid !== uid) return;
    return JSON.parse(await NodeFSP.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return;
    throw error;
  }
}

async function runOwner(directory, current) {
  const stat = await NodeFSP.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== current.uid) return;
  const owner = await regularJson(NodePath.join(directory, "runner.json"), current.uid);
  if (
    owner?.machine === current.machine &&
    owner.uid === current.uid &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    /^\d+$/.test(owner.start) &&
    /^[a-f0-9-]{36}$/.test(owner.boot) &&
    /^[a-f0-9-]{36}$/.test(owner.runId)
  )
    return owner;
}

async function atomicWrite(file, bytes) {
  const temporary = file + "." + NodeCrypto.randomUUID();
  try {
    await NodeFSP.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await NodeFSP.rename(temporary, file);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

async function activeDirectories(directories, uid) {
  const active = new Set();
  if (!directories.length) return active;
  for (const entry of await NodeFSP.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const process = NodePath.join("/proc", entry);
      if ((await NodeFSP.stat(process)).uid !== uid) continue;
      const cwd = await NodeFSP.readlink(NodePath.join(process, "cwd"));
      for (const directory of directories)
        if (cwd === directory || cwd.startsWith(directory + NodePath.sep)) active.add(directory);
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error;
    }
  }
  return active;
}

export async function pruneRuns(base, current) {
  const candidates = [];
  for (const entry of await NodeFSP.readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^mesh-fast-[A-Za-z0-9]+$/.test(entry.name)) continue;
    const directory = NodePath.join(base, entry.name);
    const owner = await runOwner(directory, current);
    if (!owner) continue;
    const completed = await regularJson(NodePath.join(directory, completeMarker), current.uid);
    if (owner.runId === current.runId ? !completed : await ownerIsActive(owner, current)) continue;
    const summary = await regularJson(NodePath.join(directory, "summary.json"), current.uid);
    const passed =
      completed?.failed === false ||
      (completed === undefined &&
        Array.isArray(summary?.results) &&
        summary.results.length > 0 &&
        summary.results.every((result) => result?.name && !result.error) &&
        Number.isFinite(summary.seconds) &&
        summary.seconds <= summary.budgetSeconds);
    const stamp = await NodeFSP.stat(
      NodePath.join(directory, completed ? completeMarker : "runner.json"),
    );
    candidates.push({ directory, owner, failed: !passed, stamp: stamp.mtimeMs });
  }
  const active = await activeDirectories(
    candidates.filter((item) => item.owner.runId !== current.runId).map((item) => item.directory),
    current.uid,
  );
  const eligible = candidates.filter((item) => !active.has(item.directory));
  const failures = eligible
    .filter((item) => item.failed)
    .sort(
      (a, b) =>
        Number(b.owner.runId === current.runId) - Number(a.owner.runId === current.runId) ||
        b.stamp - a.stamp ||
        b.directory.localeCompare(a.directory),
    );
  const retained = new Set(failures.slice(0, 3).map((item) => item.directory));
  const removed = [];
  for (const item of eligible) {
    if (item.failed && retained.has(item.directory)) continue;
    await NodeFSP.rm(item.directory, { recursive: true });
    removed.push(item.directory);
  }
  return removed;
}

export async function finishRun(directory, current, failed) {
  const owner = await runOwner(directory, current);
  if (owner?.runId !== current.runId) throw Error("Refusing to finalize an unowned mesh run");
  const base = NodePath.dirname(directory);
  const reports = NodePath.join(base, "latest");
  const reportMarker = NodePath.join(reports, ".mesh-fast-reports.json");
  let created = false;
  try {
    await NodeFSP.mkdir(reports, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = await NodeFSP.lstat(reports);
  if (!stat.isDirectory() || stat.uid !== current.uid) throw Error("Unowned mesh report directory");
  if (created)
    await atomicWrite(reportMarker, JSON.stringify({ machine: current.machine, uid: current.uid }));
  const reportOwner = await regularJson(reportMarker, current.uid);
  if (reportOwner?.machine !== current.machine || reportOwner.uid !== current.uid)
    throw Error("Unowned mesh report directory");
  for (const name of compactFiles) {
    const source = NodePath.join(directory, name);
    const destination = NodePath.join(reports, name);
    let sourceStat;
    try {
      sourceStat = await NodeFSP.lstat(source);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (["summary.json", "junit.xml", "runner.json"].includes(name)) throw error;
      await NodeFSP.rm(destination, { force: true });
      continue;
    }
    if (!sourceStat.isFile() || sourceStat.uid !== current.uid)
      throw Error("Unowned mesh report file");
    await atomicWrite(destination, await NodeFSP.readFile(source));
  }
  await atomicWrite(NodePath.join(directory, completeMarker), JSON.stringify({ failed }));
  const removed = await pruneRuns(base, current);
  await atomicWrite(
    NodePath.join(reports, "retention.json"),
    JSON.stringify({ directory, failed, removed }),
  );
  return failed ? directory : reports;
}

export async function prunePassed(directory) {
  const payloads = [];
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const machine = NodePath.join(directory, entry.name);
    let owned = false;
    for (const marker of ["server-spec.json", ".mesh-fast-node"]) {
      try {
        await NodeFSP.stat(NodePath.join(machine, marker));
        owned = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (owned)
      for (const payload of ["home", "state", "runtime"])
        payloads.push(NodePath.join(machine, payload));
  }
  if (payloads.length) await run("rm", ["-rf", "--", ...payloads]);
}
