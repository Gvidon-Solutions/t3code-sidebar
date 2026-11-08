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
import * as NodeCrypto from "node:crypto";

const run = (command, args, env, timeout = 120_000) =>
  execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const atomic = (path, value) => {
  writeFileSync(path + ".tmp", JSON.stringify(value), { mode: 0o600 });
  renameSync(path + ".tmp", path);
};
export function verifyMobileAssets(store) {
  const directory = join(store, "assets");
  for (const key of NodeFS.readdirSync(directory)) {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(key) ||
      NodeCrypto.createHash("sha256")
        .update(readFileSync(join(directory, key)))
        .digest("base64url") !== key
    )
      throw new Error(`OTA asset bytes do not match their content hash: ${key}`);
  }
}
export async function targetOperation(config, operation) {
  const prefix = config.scope === "user" ? ["--user"] : [];
  const systemctl = (...args) => run("systemctl", [...prefix, ...args]);
  const statePath = join(config.runtimeDir, "delivery-state.json");
  if (operation === "publishMobile") {
    verifyMobileAssets(config.mobileStore);
    const destination = join(config.home, "mobile-updates");
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    NodeFS.cpSync(join(config.mobileStore, "assets"), join(destination, "assets"), {
      recursive: true,
    });
    verifyMobileAssets(destination);
    copyFileSync(join(config.mobileStore, "certificate.pem"), join(destination, "certificate.pem"));
    copyFileSync(join(config.mobileStore, "catalog.json"), join(destination, "catalog.json.tmp"));
    renameSync(join(destination, "catalog.json.tmp"), join(destination, "catalog.json"));
    return true;
  }
  if (operation === "capabilities") {
    const result = NodeChildProcess.spawnSync("gh", ["--version"], { encoding: "utf8" });
    if (result.error && result.error.code !== "ENOENT") throw result.error;
    return { hasGh: result.error?.code !== "ENOENT", scope: config.scope };
  }
  const ctl = (...args) => {
    const unit = config.unitPath ? readFileSync(config.unitPath, "utf8") : "";
    const executable = /^ExecStart=(?:"([^"]+)"|(\S+))\s/m.exec(unit);
    const result = JSON.parse(
      run(
        config.node,
        [config.ctl, ...args],
        {
          T3CODE_HOME: config.home,
          T3CTL_ORIGIN: config.origin,
          T3CTL_UNIT: config.unit,
          T3CTL_T3_BIN: executable?.[1] ?? executable?.[2] ?? "",
          XDG_CONFIG_HOME: join(config.home, "delivery-client-config"),
        },
        args[1] === "t3_delivery_drain" ? (config.maxWaitMs ?? 300_000) + 30_000 : 120_000,
      ),
    );
    if (Array.isArray(result)) {
      const text = result.find((item) => item.type === "text")?.text;
      if (!text) throw new Error("Missing MCP JSON health response");
      return JSON.parse(text);
    }
    return result;
  };
  const desiredVersion = () =>
    ctl("mesh", "config", "get", "--json").current?.doc?.t3?.version ?? null;
  if (operation === "drainStatus") return ctl("tool", "t3_delivery_drain_status", "{}");
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
      if (previous.requestId)
        ctl("tool", "t3_delivery_cancel_drain", JSON.stringify({ requestId: previous.requestId }));
    }
    const directory = join(config.runtimeDir, "delivery", config.version);
    if (existsSync(directory))
      throw new Error("Runtime version already exists; use a fresh delivery version");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
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
  const cancelDrain = () => {
    if (state.requestId)
      ctl("tool", "t3_delivery_cancel_drain", JSON.stringify({ requestId: state.requestId }));
  };
  if (operation === "drain" || operation === "prepareRollback") {
    const manual = operation === "prepareRollback";
    if (manual && state.phase === "rolledBack") return state.previousHealth;
    if (manual && !["healthy", "rollbackDraining", "rollbackFenced"].includes(state.phase))
      return state.previousHealth;
    if (!manual && state.phase !== "prepared" && state.phase !== "draining")
      throw new Error("Runtime must be prepared before draining");
    const current = ctl("tool", "t3_delivery_drain_status", "{}");
    if (current.requestId && current.requestId !== state.requestId)
      throw new Error("Another delivery owns the server admission fence");
    state.requestId ??= NodeCrypto.randomUUID();
    state.now = Boolean(config.now);
    state.phase = manual ? "rollbackDraining" : "draining";
    atomic(statePath, state);
    const drained = ctl(
      "tool",
      "t3_delivery_drain",
      JSON.stringify({
        requestId: state.requestId,
        deadlineMs: config.maxWaitMs ?? 300_000,
        ...(state.now ? { now: true } : {}),
      }),
    );
    if (
      drained.requestId !== state.requestId ||
      (drained.phase !== "drained" && !(state.now && drained.phase === "draining"))
    )
      throw new Error("Server did not grant the delivery admission fence");
    state.phase = manual ? "rollbackFenced" : "fenced";
    atomic(statePath, state);
    return drained;
  }
  if (operation === "activate") {
    if (state.phase !== "fenced") throw new Error("Delivery admission fence has not been acquired");
    if (state.now !== Boolean(config.now))
      throw new Error("Delivery force authorization changed after fencing");
    const status = ctl("tool", "t3_delivery_drain_status", "{}");
    if (
      status.requestId !== state.requestId ||
      (status.phase !== "drained" && !(state.now && status.phase === "draining"))
    )
      throw new Error("Delivery admission fence was lost; no runtime switched");
    state.phase = "stopping";
    atomic(statePath, state);
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
    if (state.phase !== "trial" && state.phase !== "healthy")
      throw new Error("Only a runtime trial can commit delivery");
    state.phase = "healthy";
    atomic(statePath, state);
    cancelDrain();
    delete state.requestId;
    atomic(statePath, state);
    return true;
  }
  if (operation === "rollback") {
    if (state.phase === "rolledBack") return state.previousHealth;
    if (["prepared", "draining", "fenced"].includes(state.phase)) {
      cancelDrain();
      if (state.directory) {
        if (readFileSync(config.unitPath, "utf8").includes(join(state.directory, "t3")))
          throw new Error(
            "Prepared runtime was activated outside this delivery; refusing to remove it",
          );
        rmSync(state.directory, { recursive: true, force: true });
      }
      state.phase = "rolledBack";
      atomic(statePath, state);
      return state.previousHealth;
    }
    if (!state.requestId || state.phase === "healthy" || state.phase === "rollbackDraining")
      throw new Error("Rollback admission fence has not been acquired");
    try {
      const status = ctl("tool", "t3_delivery_drain_status", "{}");
      if (
        status.requestId !== state.requestId ||
        (status.phase !== "drained" && !(state.now && status.phase === "draining"))
      )
        throw new Error("Rollback admission fence was lost; no runtime switched");
    } catch (cause) {
      const database = new NodeSqlite.DatabaseSync(db, { readOnly: true });
      try {
        const persisted = database
          .prepare("SELECT request_id FROM delivery_admission WHERE id = 1")
          .get();
        if (persisted?.request_id !== state.requestId)
          throw new Error("Cannot verify rollback admission fence", { cause });
      } finally {
        database.close();
      }
    }
    state.phase = "rollingBack";
    atomic(statePath, state);
    systemctl("stop", config.unit);
    writeFileSync(config.unitPath, state.unit);
    if (existsSync(state.backup)) {
      const currentDatabase = new NodeSqlite.DatabaseSync(db, { readOnly: true });
      let fence;
      try {
        fence = currentDatabase
          .prepare(
            "SELECT request_id, deadline_at, deferred_json FROM delivery_admission WHERE id = 1",
          )
          .get();
        if (fence?.request_id !== state.requestId)
          throw new Error("Persistent rollback fence changed before database restore");
      } finally {
        currentDatabase.close();
      }
      const restoredPath = db + ".delivery-restore";
      copyFileSync(state.backup, restoredPath);
      const restoredDatabase = new NodeSqlite.DatabaseSync(restoredPath);
      try {
        restoredDatabase
          .prepare(
            "INSERT INTO delivery_admission (id, request_id, deadline_at, deferred_json) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET request_id=excluded.request_id, deadline_at=excluded.deadline_at, deferred_json=excluded.deferred_json",
          )
          .run(fence.request_id, fence.deadline_at, fence.deferred_json);
      } finally {
        restoredDatabase.close();
      }
      for (const suffix of ["-wal", "-shm"]) rmSync(db + suffix, { force: true });
      renameSync(restoredPath, db);
    }
    systemctl("daemon-reload");
    systemctl("start", config.unit);
    state.phase = "rolledBack";
    atomic(statePath, state);
    return state.previousHealth;
  }
  if (operation === "cancelDrain") {
    cancelDrain();
    delete state.requestId;
    atomic(statePath, state);
    return true;
  }
  throw new Error(`Unknown target operation ${operation}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  console.log(JSON.stringify(await targetOperation(input.config, input.operation)));
}
