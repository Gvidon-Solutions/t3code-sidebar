#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeAssert from "node:assert/strict";
import { machineAdapter, readConfig } from "./builder.mjs";
import { rollout } from "./rollout.mjs";

const { values } = NodeUtil.parseArgs({
  options: {
    config: { type: "string" },
    scenario: { type: "string", default: "rollout" },
    archive: { type: "string" },
    version: { type: "string" },
    ref: { type: "string", default: "HEAD" },
    out: { type: "string" },
    "force-health-failure": { type: "boolean", default: false },
  },
});
if (!values.config || !values.out)
  throw new Error(
    "Usage: e2e.mjs --config PRIVATE.json --out PRIVATE-DIR --scenario rollout|lanes [--archive FILE --version VERSION] [--force-health-failure]",
  );
const config = readConfig(values.config);
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
  NodeChildProcess.execFileSync(command, args, { encoding: "utf8", timeout: 900_000, ...options });
const started = Date.now();
if (values.scenario === "rollout") {
  if (!values.archive || !values.version)
    throw new Error("Rollout proof needs the genuine built archive and its runtime version");
  const id = `D1-${Date.now()}`;
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
  const baseline = await Promise.all(adapters.map((adapter) => adapter.health()));
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
    const rejectedVersion = `${values.version}-D1-rejected`;
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
  if (
    config.machines.some(
      (machine) => !machine.unit.startsWith("D1-") && !machine.unit.startsWith("t3-d1-"),
    )
  )
    throw new Error("Full lane proof only allows explicitly D1-prefixed isolated units");
  if (config.cleanAgent?.agent !== "devReplay")
    throw new Error("Lane proof requires isolated devReplay clean agent, never a production agent");
  const origin = config.cleanAgent.environment?.T3CTL_ORIGIN;
  if (!origin || !config.machines.some((machine) => machine.origin === origin))
    throw new Error("Clean agent must point explicitly at an allowlisted isolated origin");
  const source = NodePath.join(output, "D1-source");
  exec("git", ["clone", "--shared", "--no-checkout", config.repository, source]);
  exec("git", ["-C", source, "checkout", "-b", "D1-delivery-fixture", values.ref]);
  exec("git", ["-C", source, "config", "user.name", "D1 Delivery Fixture"]);
  exec("git", ["-C", source, "config", "user.email", "delivery@example.invalid"]);
  const titleFile = NodePath.join(
    source,
    "apps/mobile/src/features/settings/SettingsAboutRouteScreen.tsx",
  );
  const before = NodeFS.readFileSync(titleFile, "utf8");
  const marker = `About · D1 hot ${Date.now()}`;
  NodeAssert.match(before, /<SettingsScreen title="About">/);
  NodeFS.writeFileSync(
    titleFile,
    before.replace('<SettingsScreen title="About">', `<SettingsScreen title="${marker}">`),
  );
  const dirtyBefore = exec("git", ["-C", source, "status", "--porcelain"]);
  NodeAssert.match(dirtyBefore, /SettingsAboutRouteScreen/);
  const cli = NodeURL.fileURLToPath(
    new URL("../../agent-kit/skills/t3/scripts/t3ctl.mjs", import.meta.url),
  );
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
  const hot = cliCall(["hot", "--worktree", source, "--json"]);
  NodeFS.writeFileSync(NodePath.join(output, "hot.json"), JSON.stringify(hot, null, 2), {
    mode: 0o600,
  });
  const hotMs = Date.now() - hotStarted;
  NodeAssert.equal(
    exec("git", ["-C", source, "branch", "--show-current"]).trim(),
    "D1-delivery-fixture",
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
  await record({
    proof: "uncommitted hot snapshot→runtime→drain rollout→signed OTA→Replay first turn",
    durationMs: hotMs,
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
    "test: D1 isolated clean delivery",
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
  NodeAssert.ok(hotMs <= 300_000, `Hot lane target exceeded: ${hotMs}ms`);
  NodeAssert.ok(cleanMs <= 300_000, `Clean lane target exceeded: ${cleanMs}ms`);
} else throw new Error("Unknown E2E scenario");
await record({ proof: "complete", durationMs: Date.now() - started });
