#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
const { execFileSync } = NodeChildProcess;
import * as NodeHttp from "node:http";
const { createServer } = NodeHttp;
import * as NodeFS from "node:fs";
const {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} = NodeFS;
import * as NodeOS from "node:os";
const { homedir } = NodeOS;
import * as NodePath from "node:path";
const { dirname, join, resolve, delimiter } = NodePath;
import * as NodeURL from "node:url";
const { fileURLToPath } = NodeURL;
import * as NodeCrypto from "node:crypto";
const { randomUUID } = NodeCrypto;
import * as Effect from "effect/Effect";
import * as HostProcess from "../../packages/shared/src/HostProcess.ts";
import { rollout, waitForHealthy } from "./rollout.mjs";
import { buildAssets } from "./assets.mjs";

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const exec = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", timeout: 900_000, ...options });
const atomic = (path, value) => {
  writeFileSync(path + ".tmp", JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(path + ".tmp", path);
};
export const defaultConfigPath = () =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "t3-delivery/config.json");
export function versionForDelivery(packageVersion, forkText, hot, stamp) {
  const core = /^(\d+\.\d+\.\d+)(?:[-+].*)?$/.exec(packageVersion)?.[1];
  if (!core) throw new Error("Invalid server package version");
  const synced = /Last synced with upstream release `v(\d+\.\d+\.\d+)`/.exec(forkText)?.[1];
  const newer = (left, right) => {
    const a = left.split(".").map(BigInt);
    const b = right.split(".").map(BigInt);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };
  return `${synced && newer(synced, core) ? synced : core}-${hot ? "hot" : "delivery"}.${stamp.replaceAll(/\D/g, "")}`;
}

export function readConfig(path = defaultConfigPath()) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  for (const key of ["repository", "buildDir", "stateDir", "socket"]) {
    if (typeof config[key] !== "string" || !config[key].startsWith("/"))
      throw new Error(`Config requires absolute ${key}`);
  }
  if (!Array.isArray(config.machines) || !config.machines.length)
    throw new Error("Configure allowed machines");
  for (const machine of config.machines) {
    if (!/^[a-z][a-z0-9-]*$/.test(machine.name)) throw new Error("Invalid machine name");
    for (const key of ["runtimeDir", "home", "unitPath", "node", "ctl"]) {
      if (typeof machine[key] !== "string" || !machine[key].startsWith("/"))
        throw new Error(`${machine.name}: absolute ${key} required`);
    }
    if (!["user", "system"].includes(machine.scope))
      throw new Error("Machine scope must be user or system");
    if (!machine.unit || !machine.origin) throw new Error("Machine needs unit and origin");
  }
  return config;
}
export function snapshot(worktree, id = new Date().toISOString().replaceAll(/[-:.]/g, "")) {
  worktree = exec("git", ["-C", worktree, "rev-parse", "--show-toplevel"]).trim();
  const index = join(worktree, `.delivery-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const git = (...args) => exec("git", ["-C", worktree, ...args], { env }).trim();
  try {
    const parent = git("rev-parse", "HEAD");
    git("read-tree", parent);
    git("add", "-A", "--", ".", ":(exclude).delivery-index-*");
    const tree = git("write-tree");
    const commit = git("commit-tree", tree, "-p", parent, "-m", `hot: ${id}`);
    const branch = `hot/${id}`;
    git("update-ref", `refs/heads/${branch}`, commit, "0000000000000000000000000000000000000000");
    return { commit, branch, parent };
  } finally {
    rmSync(index, { force: true });
    rmSync(index + ".lock", { force: true });
  }
}
function machineAdapter(machine, archive, version, id, now = false) {
  const target = fileURLToPath(new URL("./target.mjs", import.meta.url));
  const remoteScript = join(machine.runtimeDir, "delivery-target.mjs");
  const remoteArchive = join(machine.runtimeDir, `${id}.tar.gz`);
  const ssh = (args, options) =>
    exec("ssh", ["-o", "BatchMode=yes", machine.ssh, ...args], options);
  if (machine.ssh && archive) {
    ssh([`mkdir -p ${quote(machine.runtimeDir)}`]);
    exec("scp", [target, `${machine.ssh}:${remoteScript}`]);
    exec("scp", [archive, `${machine.ssh}:${remoteArchive}`]);
  }
  const call = (operation) => {
    const input = JSON.stringify({
      operation,
      config: { ...machine, archive: machine.ssh ? remoteArchive : archive, version, now },
    });
    const text = machine.ssh
      ? ssh([`${quote(machine.node)} ${quote(remoteScript)}`], { input })
      : exec(machine.node, [target], { input });
    return JSON.parse(text);
  };
  return {
    name: machine.name,
    busy: async () => call("busy"),
    health: async () => call("health"),
    prepare: async () => call("prepare"),
    activate: async () => call("activate"),
    rollback: async () => call("rollback"),
    commit: () => call("commit"),
  };
}
export async function deliver(config, request) {
  const platform = Effect.runSync(Effect.service(HostProcess.Platform));
  const arch = Effect.runSync(Effect.service(HostProcess.Architecture));
  const id = new Date().toISOString().replaceAll(/[-:.]/g, "");
  const logDir = join(config.stateDir, id);
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const events = [];
  const journal = async (event) => {
    events.push({ ...event, at: new Date().toISOString() });
    atomic(join(logDir, "events.json"), events);
  };
  const selected = request.machines
    ? String(request.machines).split(",")
    : config.machines.map((machine) => machine.name);
  const machines = selected.map(
    (name) =>
      config.machines.find((machine) => machine.name === name) ||
      (() => {
        throw new Error(`Machine is not in delivery allowlist: ${name}`);
      })(),
  );

  if (new Set(selected).size !== selected.length) throw new Error("Duplicate target machines");
  if (request.action === "rollback") {
    for (const machine of [...machines].reverse()) {
      const adapter = machineAdapter(machine, null, "rollback", id);
      const previous = await adapter.rollback();
      await waitForHealthy(adapter, previous.version, [previous], config.healthWaitMs ?? 120_000);
      await journal({ machine: machine.name, phase: "rolledBack" });
    }
    return { id, logDir };
  }
  if (!request.now)
    throw new Error(
      "Idle delivery is unavailable: this direct-unit adapter has no server admission guard. No runtime switched. --now explicitly skips the idle window.",
    );
  if (request.hot && request.release)
    throw new Error("Hot deliveries never publish release assets");
  if (request.hot && !config.cleanAgent?.project)
    throw new Error("Configure cleanAgent.project before a hot deployment");
  if (!request.hot && (!Array.isArray(config.gate) || !config.gate.length))
    throw new Error("Clean delivery requires the T1 gate command in local config");
  const source = request.hot ? resolve(request.worktree || config.repository) : config.repository;
  const hot = request.hot ? snapshot(source, id) : null;
  const commit =
    hot?.commit ||
    exec("git", [
      "-C",
      source,
      "rev-parse",
      "--verify",
      `${request.ref || "HEAD"}^{commit}`,
    ]).trim();
  const historyPath = join(config.stateDir, "last-build.json");
  const previousBuild = existsSync(historyPath)
    ? JSON.parse(readFileSync(historyPath, "utf8"))
    : null;
  const previous = previousBuild?.commit;
  const paths = previous
    ? exec("git", ["-C", source, "diff", "--name-only", previous, commit]).split("\n")
    : ["apps/desktop/", "apps/mobile/"];
  const version =
    request.version ||
    versionForDelivery(
      JSON.parse(exec("git", ["-C", source, "show", `${commit}:apps/server/package.json`])).version,
      exec("git", ["-C", source, "show", `${commit}:FORK.md`]),
      request.hot,
      id,
    );
  if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error("Invalid delivery version");
  if (!existsSync(join(config.buildDir, ".git")))
    exec("git", ["clone", "--shared", "--no-checkout", source, config.buildDir]);
  exec("git", ["-C", config.buildDir, "fetch", source, commit]);
  exec("git", ["-C", config.buildDir, "checkout", "--detach", "--force", commit]);
  const run = (command, args, cwd = config.buildDir, extraEnv = {}) => {
    const start = Date.now();
    const output = exec(command, args, {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
        PATH: join(config.buildDir, "node_modules/.bin") + delimiter + process.env.PATH,
      },
    });
    writeFileSync(join(logDir, `${events.length}.log`), output, { mode: 0o600 });
    return journal({
      phase: "command",
      command: [command, ...args],
      durationMs: Date.now() - start,
    });
  };
  try {
    await run("pnpm", ["install", "--frozen-lockfile"]);
    if (!request.hot) await run(config.gate[0], config.gate.slice(1));
    await run(process.execPath, ["scripts/update-release-package-versions.ts", version]);
    await run("vp", ["run", "--filter", "t3", "build"]);
    await run(process.execPath, ["apps/server/scripts/cli.ts", "build-exe"]);
    await run("cargo", [
      ...(config.rustToolchain ? [`+${config.rustToolchain}`] : []),
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      "native/resource-monitor/Cargo.toml",
    ]);
    const monitor = join(
      config.buildDir,
      "native/resource-monitor/target/release/t3-resource-monitor",
    );
    const monitorDir = join(logDir, "resource-monitor", `${platform}-${arch}`);
    mkdirSync(monitorDir, { recursive: true });
    copyFileSync(monitor, join(monitorDir, "t3-resource-monitor"));
    await run(process.execPath, [
      "scripts/build-cli-archive.ts",
      "--platform",
      platform === "darwin" ? "mac" : "linux",
      "--arch",
      arch,
      "--version",
      version,
      "--resource-monitor-dir",
      dirname(monitorDir),
      "--output-dir",
      logDir,
    ]);
    const archive = join(
      logDir,
      readdirSync(logDir).find((file) => file.endsWith(".tar.gz")) || "missing-runtime",
    );
    if (!existsSync(archive)) throw new Error("Runtime archive missing");
    const artifacts = await buildAssets({
      config,
      machines,
      paths,
      logDir,
      version,
      previousFingerprint: previousBuild?.nativeFingerprint,
      arch,
      run,
    });
    const adapters = machines.map((machine) =>
      machineAdapter(machine, archive, version, id, request.now),
    );
    await rollout(
      adapters,
      version,
      {
        now: request.now,
        maxWaitMs: config.maxWaitMs ?? 300_000,
        healthWaitMs: config.healthWaitMs ?? 120_000,
      },
      journal,
    );
    for (const adapter of adapters) adapter.commit();
    if (!request.hot && request.release) {
      if (!config.releaseRepository) throw new Error("Configure releaseRepository before upload");
      await run("gh", [
        "release",
        "upload",
        request.release,
        archive,
        ...artifacts.files,
        "--repo",
        config.releaseRepository,
      ]);
    }
    if (request.hot) {
      if (!config.cleanAgent?.project)
        throw new Error("Hot change deployed, but cleanAgent.project is not configured");
      const diff = exec("git", ["-C", source, "diff", `${hot.parent}..${commit}`]);
      const brief = `Turn this hot change into a clean change: proper code, tests, T1 gate, merge to ws, release; if the change is wrong, do not merge it, explain in the inbox.\nSource: ${source}\nBranch: ${hot.branch}\nCommit: ${commit}\n\n${diff}`;
      const briefPath = join(logDir, "clean-brief.md");
      writeFileSync(briefPath, brief, { mode: 0o600 });
      await run(config.cleanAgent.ctl || "t3ctl", [
        "new",
        "--project",
        config.cleanAgent.project,
        "--agent",
        config.cleanAgent.agent || "codex",
        "--model",
        config.cleanAgent.model || "gpt-6.1-sol",
        "--file",
        briefPath,
      ]);
    }
    atomic(historyPath, {
      commit,
      version,
      archive,
      nativeFingerprint: artifacts.nativeFingerprint,
    });
    await journal({ phase: "complete", commit, version });
    return { id, version, commit, logDir };
  } catch (error) {
    await journal({ phase: "failed", reason: error.message });
    throw error;
  }
}

export function serve(config) {
  mkdirSync(dirname(config.socket), { recursive: true, mode: 0o700 });
  if (existsSync(config.socket))
    throw new Error(
      "Builder socket already exists; verify no builder runs before removing a stale socket",
    );
  let queue = Promise.resolve();
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/deliver") {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 65536) req.destroy(new Error("Request too large"));
    });
    req.on("end", () => {
      queue = queue.then(async () => {
        try {
          const result = await deliver(config, JSON.parse(body));
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    });
  });
  server.listen(config.socket, () => chmodSync(config.socket, 0o600));
  server.on("close", () => rmSync(config.socket, { force: true }));
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = readConfig(process.argv[3]);
  if (process.argv[2] === "serve") serve(config);
  else if (process.argv[2] === "run")
    console.log(JSON.stringify(await deliver(config, JSON.parse(process.argv[4] || "{}"))));
  else throw new Error("Usage: builder.mjs serve|run [config.json] [request.json]");
}
