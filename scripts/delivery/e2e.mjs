#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeAssert from "node:assert/strict";
import { machineAdapter, readConfig } from "./builder.mjs";
import { rollout } from "./rollout.mjs";
import { LONG_COMMAND_TIMEOUT_MS } from "../lib/shell.mjs";

const { values } = NodeUtil.parseArgs({
  options: {
    config: { type: "string" },
    scenario: { type: "string", default: "rollout" },
    archive: { type: "string" },
    version: { type: "string" },
    ref: { type: "string", default: "HEAD" },
    out: { type: "string" },
    "force-health-failure": { type: "boolean", default: false },
    "exercise-idle-wait": { type: "boolean", default: false },
  },
});
if (!values.config || !values.out)
  throw new Error(
    "Usage: e2e.mjs --config PRIVATE.json --out PRIVATE-DIR --scenario rollout|lanes [--archive FILE --version VERSION] [--force-health-failure]",
  );
const config = readConfig(values.config);
if (config.machines.some((machine) => !/^delivery-bed-/.test(machine.unit)))
  throw new Error("Delivery acceptance only allows delivery-bed-prefixed isolated units");
const output = NodePath.resolve(values.out);
NodeFS.mkdirSync(output, { recursive: true, mode: 0o700 });
const events = [];
const record = async (event) => {
  events.push({ ...event, at: new Date().toISOString() });
  NodeFS.writeFileSync(NodePath.join(output, "events.json"), JSON.stringify(events, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(event));
};
const exec = (command, args, options = {}) =>
  NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    timeout: LONG_COMMAND_TIMEOUT_MS,
    ...options,
  });
const cli = NodeURL.fileURLToPath(
  new URL("../../agent-kit/skills/t3/scripts/t3ctl.mjs", import.meta.url),
);
const isolatedReplay = (args) => {
  const environment = config.cleanAgent?.environment;
  if (
    config.cleanAgent?.agent !== "devReplay" ||
    !environment?.T3CTL_ORIGIN ||
    !config.machines.some((machine) => machine.origin === environment.T3CTL_ORIGIN)
  )
    throw new Error("Replay proof requires an explicitly isolated devReplay connection");
  return JSON.parse(
    exec(process.execPath, [cli, ...args], { env: { ...process.env, ...environment } }),
  );
};
async function waitForRunningReplay(threadId) {
  const machine = config.machines.find(
    (machine) => machine.origin === config.cleanAgent.environment.T3CTL_ORIGIN,
  );
  const unit = NodeFS.readFileSync(machine.unitPath, "utf8");
  const executable = /^ExecStart=(?:"([^"]+)"|(\S+))\s/m.exec(unit);
  const token = exec(executable[1] ?? executable[2], [
    "auth",
    "session",
    "issue",
    "--ttl",
    "2m",
    "--label",
    "delivery-bed-events",
    "--token-only",
    "--base-dir",
    machine.home,
  ])
    .trim()
    .split("\n")
    .at(-1);
  const response = await fetch(new URL("/api/auth/websocket-ticket", machine.origin), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`delivery bed event ticket returned ${response.status}`);
  const { ticket } = await response.json();
  const socket = new WebSocket(
    `${machine.origin.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}&orchestrationProtocol=2&clientSurface=cli`,
  );
  await new Promise((resolveRunning, rejectRunning) => {
    let settled = false;
    const deadline = setTimeout(
      () => finish(new Error("delivery bed Replay never reached running")),
      60_000,
    );
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ _tag: "Interrupt", requestId: "delivery-bed-running" }));
      socket.close();
      if (error) rejectRunning(error);
      else resolveRunning();
    };
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          _tag: "Request",
          id: "delivery-bed-running",
          tag: "orchestration.subscribeThread",
          payload: { threadId },
          headers: [],
        }),
      ),
    );
    socket.addEventListener("error", (event) =>
      finish(new Error("delivery bed Replay event connection failed", { cause: event.error })),
    );
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error("delivery bed Replay event stream closed before running"));
    });
    socket.addEventListener("message", (event) => {
      for (const line of String(event.data).split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message._tag === "Ping") {
          socket.send(JSON.stringify({ _tag: "Pong" }));
          continue;
        }
        if (message.requestId !== "delivery-bed-running") continue;
        if (message._tag === "Chunk") {
          for (const item of message.values) {
            const runs =
              item.kind === "snapshot"
                ? item.projection.runs
                : item.kind === "event" && ["run.created", "run.updated"].includes(item.event.type)
                  ? [item.event.payload]
                  : [];
            if (runs.some((run) => run.status === "running")) {
              finish();
              return;
            }
            if (runs.some((run) => ["completed", "failed", "interrupted"].includes(run.status))) {
              finish(
                new Error(
                  "delivery bed Replay finished before the admission wait could be observed",
                ),
              );
              return;
            }
          }
          socket.send(JSON.stringify({ _tag: "Ack", requestId: "delivery-bed-running" }));
        } else if (message._tag === "Exit" || message._tag === "Defect")
          finish(
            new Error(
              `delivery bed Replay event subscription ended: ${JSON.stringify(message.exit ?? message.defect)}`,
            ),
          );
      }
    });
  });
}
const started = Date.now();
if (values.scenario === "rollout") {
  if (!values.archive || !values.version)
    throw new Error("Rollout proof needs the genuine built archive and its runtime version");
  const id = `delivery-bed-${Date.now()}`;
  const adapters = config.machines.map((machine) =>
    machineAdapter(
      machine,
      NodePath.resolve(values.archive),
      values.version,
      id,
      false,
      config.maxWaitMs,
    ),
  );
  if (values["exercise-idle-wait"]) {
    const drain = adapters[0].drain;
    adapters[0].drain = async () => {
      const brief = NodePath.join(output, "delivery-bed-drain-wait.md");
      NodeFS.writeFileSync(
        brief,
        "delivery bed isolated admission-drain fixture. Replay this recorded turn; do not modify any repository.",
        { mode: 0o600 },
      );
      const thread = isolatedReplay([
        "new",
        "--project",
        config.cleanAgent.project,
        "--agent",
        "devReplay",
        "--model",
        config.cleanAgent.model,
        "--file",
        brief,
        "--json",
      ]);
      await waitForRunningReplay(thread.threadId);
      await record({
        proof: "Replay is running immediately before admission drain",
        threadId: thread.threadId,
        threadStatus: "running",
      });
      const result = await drain();
      const settled = isolatedReplay(["wait", thread.threadId, "--timeout", "2m", "--json"]);
      NodeAssert.equal(settled.timedOut, false);
      const answer = isolatedReplay(["output", thread.threadId, "--json"]);
      NodeAssert.ok(answer?.text);
      await record({ proof: "Replay finishes before runtime switch", threadId: thread.threadId });
      return result;
    };
  }
  const baseline = await Promise.all(adapters.map((adapter) => adapter.health()));
  for (let index = 0; index < adapters.length; index++) {
    const capabilities = await adapters[index].capabilities();
    if (config.machines[index].requireNoGh)
      NodeAssert.equal(
        capabilities.hasGh,
        false,
        "The configured system target must operate with no gh executable",
      );
    await record({
      proof: "target execution environment",
      machine: adapters[index].name,
      ...capabilities,
    });
  }
  NodeFS.writeFileSync(NodePath.join(output, "baseline.json"), JSON.stringify(baseline, null, 2), {
    mode: 0o600,
  });
  await rollout(
    adapters,
    values.version,
    { maxWaitMs: config.maxWaitMs, healthWaitMs: config.healthWaitMs },
    record,
  );
  await record({
    proof: "mixed user/system rollout",
    durationMs: Date.now() - started,
    scopes: config.machines.map((machine) => machine.scope),
    sshTargets: config.machines.filter((machine) => machine.ssh).length,
  });
  if (values["force-health-failure"]) {
    const rejectedVersion = `${values.version}-delivery-bed-rejected`;
    const failed = config.machines.map((machine) =>
      machineAdapter(
        machine,
        NodePath.resolve(values.archive),
        rejectedVersion,
        id + "-failure",
        false,
        config.maxWaitMs,
      ),
    );
    const failureEvents = [];
    await NodeAssert.rejects(
      rollout(
        failed,
        rejectedVersion,
        { maxWaitMs: config.maxWaitMs, healthWaitMs: 5000 },
        async (event) => {
          failureEvents.push(event);
          await record(event);
        },
      ),
      /rolled back; rollout stopped: Version mismatch/,
    );
    NodeAssert.equal(
      failureEvents.filter((event) => event.phase === "prepare").length,
      1,
      "failed trial must stop before preparing the next machine",
    );
    NodeAssert.equal((await failed[0].health()).version, values.version);
    await record({ proof: "actual health mismatch restores previous runtime and stops rollout" });
  }
} else if (values.scenario === "lanes") {
  if (config.machines.some((machine) => !machine.unit.startsWith("delivery-bed-")))
    throw new Error("Full lane proof only allows explicitly delivery-bed-prefixed isolated units");
  if (config.cleanAgent?.agent !== "devReplay")
    throw new Error("Lane proof requires isolated devReplay clean agent, never a production agent");
  const origin = config.cleanAgent.environment?.T3CTL_ORIGIN;
  if (!origin || !config.machines.some((machine) => machine.origin === origin))
    throw new Error("Clean agent must point explicitly at an allowlisted isolated origin");
  const source = NodePath.join(output, "delivery-bed-source");
  exec("git", ["clone", "--shared", "--no-checkout", config.repository, source]);
  exec("git", ["-C", source, "checkout", "-b", "delivery-bed-delivery-fixture", values.ref]);
  exec("git", ["-C", source, "config", "user.name", "Delivery Bed Fixture"]);
  exec("git", ["-C", source, "config", "user.email", "delivery@example.invalid"]);
  const titleFile = NodePath.join(
    source,
    "apps/mobile/src/features/settings/SettingsAboutRouteScreen.tsx",
  );
  const before = NodeFS.readFileSync(titleFile, "utf8");
  const marker = `About · delivery bed hot ${Date.now()}`;
  NodeAssert.match(before, /<SettingsScreen title="About">/);
  NodeFS.writeFileSync(
    titleFile,
    before.replace('<SettingsScreen title="About">', `<SettingsScreen title="${marker}">`),
  );
  const dirtyBefore = exec("git", ["-C", source, "status", "--porcelain"]);
  NodeAssert.match(dirtyBefore, /SettingsAboutRouteScreen/);
  const cliCall = (args, environment = {}) =>
    JSON.parse(
      exec(process.execPath, [cli, ...args], {
        env: {
          ...process.env,
          ...environment,
          T3_DELIVERY_CONFIG: NodePath.resolve(values.config),
        },
      }),
    );
  const hotStarted = Date.now();
  await record({
    proof: "hot command started",
    startedEpochMs: hotStarted,
    startedAt: new Date(hotStarted).toISOString(),
    marker,
    source,
  });
  const hot = cliCall(["hot", "--worktree", source, "--json"]);
  NodeFS.writeFileSync(NodePath.join(output, "hot.json"), JSON.stringify(hot, null, 2), {
    mode: 0o600,
  });
  const hotCommandMs = Date.now() - hotStarted;
  NodeAssert.equal(
    exec("git", ["-C", source, "branch", "--show-current"]).trim(),
    "delivery-bed-delivery-fixture",
  );
  NodeAssert.equal(exec("git", ["-C", source, "status", "--porcelain"]), dirtyBefore);
  const hotBranches = exec("git", [
    "-C",
    source,
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads/hot/",
  ]);
  NodeAssert.match(hotBranches, /refs\/heads\/hot\//);
  const catalog = JSON.parse(
    NodeFS.readFileSync(NodePath.join(config.ota.store, "catalog.json"), "utf8"),
  );
  NodeAssert.ok(catalog.releases.length > 0, "Hot lane must actually publish a signed OTA export");
  const thread = JSON.parse(
    NodeFS.readFileSync(NodePath.join(hot.logDir, "clean-thread.json"), "utf8"),
  );
  NodeAssert.ok(thread.threadId);
  const cleanEnv = config.cleanAgent.environment;
  const settled = cliCall(["wait", thread.threadId, "--timeout", "2m", "--json"], cleanEnv);
  NodeAssert.equal(settled.timedOut, false);
  const answer = cliCall(["output", thread.threadId, "--json"], cleanEnv);
  NodeAssert.ok(answer?.text, "Replay clean-change thread must produce its first assistant answer");
  NodeFS.writeFileSync(
    NodePath.join(output, "clean-agent.json"),
    JSON.stringify({ thread, settled, answer }, null, 2),
    { mode: 0o600 },
  );
  const hotFirstTurnMs = Date.now() - hotStarted;
  await record({
    proof: "uncommitted hot snapshot→runtime→drain rollout→signed OTA→Replay first turn",
    durationMs: hotFirstTurnMs,
    commandDurationMs: hotCommandMs,
    startedEpochMs: hotStarted,
    marker,
    source,
    version: hot.version,
    commit: hot.commit,
  });
  exec("git", [
    "-C",
    source,
    "add",
    "apps/mobile/src/features/settings/SettingsAboutRouteScreen.tsx",
  ]);
  exec("git", [
    "-C",
    source,
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--no-verify",
    "-m",
    "test: delivery bed isolated clean delivery",
  ]);
  const cleanCommit = exec("git", ["-C", source, "rev-parse", "HEAD"]).trim();
  exec("git", ["-C", config.repository, "fetch", source, cleanCommit]);
  const cleanStarted = Date.now();
  const clean = cliCall(["deploy", "--ref", cleanCommit, "--json"]);
  const cleanMs = Date.now() - cleanStarted;
  NodeFS.writeFileSync(NodePath.join(output, "clean.json"), JSON.stringify(clean, null, 2), {
    mode: 0o600,
  });
  const cleanJournal = JSON.parse(
    NodeFS.readFileSync(NodePath.join(clean.logDir, "events.json"), "utf8"),
  );
  NodeAssert.ok(
    cleanJournal.some(
      (event) =>
        event.phase === "command" && JSON.stringify(event.command) === JSON.stringify(config.gate),
    ),
    "Clean lane must execute the configured gate",
  );
  NodeAssert.ok(
    !cleanJournal.some((event) => event.command?.[0] === "gh"),
    "The isolated proof must never publish a release",
  );
  await record({
    proof: "clean configured gate→runtime→drain rollout",
    durationMs: cleanMs,
    version: clean.version,
    commit: clean.commit,
  });
  NodeAssert.ok(hotFirstTurnMs <= 300_000, `Hot lane target exceeded: ${hotFirstTurnMs}ms`);
  NodeAssert.ok(cleanMs <= 300_000, `Clean lane target exceeded: ${cleanMs}ms`);
} else throw new Error("Unknown E2E scenario");
await record({ proof: "complete", durationMs: Date.now() - started });
