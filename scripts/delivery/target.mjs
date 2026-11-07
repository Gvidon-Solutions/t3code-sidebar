import * as NodeChildProcess from "node:child_process";
const { execFileSync } = NodeChildProcess;
import * as NodeFS from "node:fs";
const { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } =
  NodeFS;
import * as NodePath from "node:path";
const { join } = NodePath;
import * as NodeURL from "node:url";
const { fileURLToPath } = NodeURL;
import * as NodeSqlite from "node:sqlite";

const run = (command, args, env) =>
  execFileSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const atomic = (path, value) => {
  writeFileSync(path + ".tmp", JSON.stringify(value), { mode: 0o600 });
  renameSync(path + ".tmp", path);
};
export async function targetOperation(config, operation) {
  const prefix = config.scope === "user" ? ["--user"] : [];
  const systemctl = (...args) => run("systemctl", [...prefix, ...args]);
  const statePath = join(config.runtimeDir, "delivery-state.json");
  const ctl = (...args) => {
    const result = JSON.parse(
      run(config.node, [config.ctl, ...args], {
        T3CODE_HOME: config.home,
        T3CTL_ORIGIN: config.origin,
        T3CTL_UNIT: config.unit,
        XDG_CONFIG_HOME: join(config.home, "delivery-client-config"),
      }),
    );
    if (Array.isArray(result)) {
      const text = result.find((item) => item.type === "text")?.text;
      if (!text) throw new Error("Missing MCP JSON health response");
      return JSON.parse(text);
    }
    return result;
  };
  if (operation === "busy") {
    let cursor;
    do {
      const page = ctl(
        "tool",
        "t3_thread_list",
        JSON.stringify({
          allProjects: true,
          includeSubagents: true,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      if (
        page.threads.some((row) =>
          ["running", "starting", "preparing", "queued", "waiting"].includes(row.status),
        )
      )
        return true;
      cursor = page.nextCursor;
    } while (cursor !== null && cursor !== undefined);
    return false;
  }
  const desiredVersion = () =>
    ctl("mesh", "config", "get", "--json").current?.doc?.t3?.version ?? null;
  if (operation === "health")
    return { ...ctl("tool", "t3_mesh_update_health", "{}"), desiredVersion: desiredVersion() };
  if (operation === "prepare") {
    const desired = desiredVersion();
    if (desired && desired !== config.version)
      throw new Error(`Managed mesh version ${desired} conflicts with delivery ${config.version}`);
    mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
    if (existsSync(statePath)) {
      const previous = JSON.parse(readFileSync(statePath, "utf8"));
      if (previous.phase !== "healthy" && previous.phase !== "rolledBack")
        throw new Error("Unfinished delivery journal; run deploy rollback first");
    }
    const directory = join(config.runtimeDir, config.version);
    if (existsSync(directory))
      throw new Error("Runtime version already exists; use a fresh delivery version");
    mkdirSync(directory, { mode: 0o700 });
    run("tar", ["xzf", config.archive, "-C", directory, "--strip-components=1"]);
    if (!existsSync(join(directory, "t3"))) throw new Error("Runtime archive has no executable");
    const unit = readFileSync(config.unitPath, "utf8");
    const next = unit.replace(
      /(ExecStart=\s*"?)[^\n"]*\/t3(?=["\s])/u,
      (_, start) => `${start}${join(directory, "t3")}`,
    );
    if (unit === next) throw new Error("Unit must have an absolute t3 ExecStart executable");
    atomic(statePath, {
      phase: "prepared",
      unit,
      next,
      previousHealth: ctl("tool", "t3_mesh_update_health", "{}"),
      backup: join(config.runtimeDir, `backup-${config.version}.sqlite`),
      directory,
    });
    return true;
  }
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const db = join(config.home, "userdata", "statev2.sqlite");
  if (operation === "activate") {
    if (!config.now)
      throw new Error(
        "Idle delivery requires a server admission guard; no runtime switched. --now explicitly skips the idle window.",
      );
    if (state.phase !== "prepared") throw new Error("Delivery is not prepared");
    systemctl("stop", config.unit);
    state.phase = "stopped";
    atomic(statePath, state);
    const database = new NodeSqlite.DatabaseSync(db, { readOnly: true });
    try {
      await NodeSqlite.backup(database, state.backup);
    } finally {
      database.close();
    }
    state.phase = "backedUp";
    atomic(statePath, state);
    writeFileSync(config.unitPath, state.next);
    systemctl("daemon-reload");
    systemctl("start", config.unit);
    state.phase = "trial";
    atomic(statePath, state);
    return true;
  }
  if (operation === "commit") {
    state.phase = "healthy";
    atomic(statePath, state);
    return true;
  }
  if (operation === "rollback") {
    if (state.phase === "rolledBack") return state.previousHealth;
    systemctl("stop", config.unit);
    writeFileSync(config.unitPath, state.unit);
    if (existsSync(state.backup)) {
      copyFileSync(state.backup, db);
      for (const suffix of ["-wal", "-shm"]) rmSync(db + suffix, { force: true });
    }
    systemctl("daemon-reload");
    systemctl("start", config.unit);
    state.phase = "rolledBack";
    atomic(statePath, state);
    return state.previousHealth;
  }
  throw new Error(`Unknown target operation ${operation}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  console.log(JSON.stringify(await targetOperation(input.config, input.operation)));
}
