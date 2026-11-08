#!/usr/bin/env node
import { runSync as runSyncCommand, quote } from "../lib/shell.mjs";
import { writeManagedSshdConfig } from "../lib/managed-sshd.mjs";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";

const UNIT_PATTERN = /^delivery-bed-[a-z-]+\.service$/;
const assertMachine = (machine) => {
  if (!UNIT_PATTERN.test(machine.unit) || NodePath.basename(machine.unitPath) !== machine.unit)
    throw new Error("Bed setup only manages delivery-bed-prefixed isolated units");
  if (!Number.isInteger(machine.sshdPort) || machine.sshdPort < 1024)
    throw new Error("Set a private sshdPort for each fixture");
};

/**
 * Two modes share one file so a remote fixture needs a single upload:
 * `--config …` stages and starts fixtures, and stdin JSON applies one target.
 */
const setupRequested = process.argv.includes("--config");
if (setupRequested) await setUpFixtures();
else await applyTarget(JSON.parse(NodeFS.readFileSync(0, "utf8")));

async function setUpFixtures() {
  const { readConfig } = await import("./builder.mjs");
  const { values } = NodeUtil.parseArgs({
    options: {
      config: { type: "string" },
      archive: { type: "string" },
      "bed-lock-file": { type: "string" },
      "bed-lock-owner": { type: "string", default: "delivery-bed" },
    },
  });
  if (!values.config || !values.archive)
    throw new Error(
      "Usage: node bed-target.mjs --config PRIVATE.json --archive BASELINE.tar.gz --bed-lock-file /tmp/mesh-bed.lock/owner",
    );
  const config = readConfig(values.config);
  const archive = NodePath.resolve(values.archive);
  const targetSource = NodeURL.fileURLToPath(import.meta.url);
  const scripts = NodeURL.fileURLToPath(
    new URL("../../agent-kit/skills/t3/scripts/", import.meta.url),
  );
  for (const machine of config.machines) {
    assertMachine(machine);
    const input = { machine, archive, lockFile: null, lockOwner: values["bed-lock-owner"] };
    if (!machine.ssh) {
      console.log(
        runSyncCommand(process.execPath, [targetSource], { input: JSON.stringify(input) }).trim(),
      );
      continue;
    }
    if (!values["bed-lock-file"])
      throw new Error("Remote fixture setup requires the shared bed lock");
    const ssh = (command, options) =>
      runSyncCommand(
        "ssh",
        ["-o", "BatchMode=yes", ...(machine.sshArgs ?? []), machine.ssh, command],
        options,
      );
    const lock = values["bed-lock-file"];
    const check = `test "$(cat ${quote(lock)})" = ${quote(values["bed-lock-owner"])} || exit 75\n`;
    const binaryDir = NodePath.join(machine.home, "bin"),
      kit = NodePath.dirname(machine.ctl);
    const lib = NodePath.join(machine.home, "lib");
    ssh(check + `mkdir -p ${quote(binaryDir)} ${quote(kit)} ${quote(lib)}`);
    const upload = (source, dest) =>
      runSyncCommand("scp", [...(machine.scpArgs ?? []), source, `${machine.ssh}:${dest}`]);
    const node = NodePath.join(binaryDir, "node26");
    upload(process.execPath, node);
    ssh(check + `chmod 0755 ${quote(node)}`);
    upload(targetSource, NodePath.join(binaryDir, "bed-target.mjs"));
    upload(
      NodeURL.fileURLToPath(new URL("../lib/shell.mjs", import.meta.url)),
      NodePath.join(lib, "shell.mjs"),
    );
    upload(
      NodeURL.fileURLToPath(new URL("../lib/managed-sshd.mjs", import.meta.url)),
      NodePath.join(lib, "managed-sshd.mjs"),
    );
    upload(NodePath.join(scripts, "t3ctl.mjs"), machine.ctl);
    upload(NodePath.join(scripts, "server-runtime.mjs"), NodePath.join(kit, "server-runtime.mjs"));
    input.archive = NodePath.join(machine.home, "delivery-bed-baseline.tar.gz");
    upload(archive, input.archive);
    input.lockFile = lock;
    const command = `${machine.scope === "system" ? "sudo -n " : ""}${quote(node)} ${quote(NodePath.join(binaryDir, "bed-target.mjs"))}`;
    console.log(ssh(check + command, { input: JSON.stringify(input) }).trim());
  }
}

async function applyTarget({ machine, archive, lockFile, lockOwner }) {
  assertMachine(machine);
  const checkLock = () => {
    if (lockFile && NodeFS.readFileSync(lockFile, "utf8").trim() !== lockOwner)
      throw new Error("The delivery fixture no longer owns the bed lock");
  };
  checkLock();
  const marker = NodePath.join(machine.home, "delivery-bed-fixture-owned.json");
  if (
    NodeFS.existsSync(NodePath.join(machine.home, "userdata/statev2.sqlite")) &&
    !NodeFS.existsSync(marker)
  )
    throw new Error("Refusing a pre-existing non-fixture T3 database");
  NodeFS.mkdirSync(machine.home, { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(marker, JSON.stringify({ fixture: "delivery bed", unit: machine.unit }), {
    mode: 0o600,
  });
  const agentHome = NodePath.join(machine.home, "agent-home");
  const sshDir = NodePath.join(agentHome, "sshd");
  const tools = NodePath.join(machine.home, "tools");
  const sshConfig = await writeManagedSshdConfig({
    home: agentHome,
    port: machine.sshdPort,
    directory: sshDir,
    authorizedKeysFile: NodePath.join(agentHome, ".ssh/authorized_keys"),
    extraLines: [`SetEnv PATH=${tools}`],
  });
  const prefix = machine.scope === "user" ? ["--user"] : [];
  const control = (...args) => {
    checkLock();
    return runSyncCommand("systemctl", [...prefix, ...args]);
  };
  NodeFS.mkdirSync(tools, { recursive: true, mode: 0o755 });
  for (const binary of [
    "systemctl",
    "tar",
    "gzip",
    "ssh",
    "ssh-keygen",
    "scp",
    "git",
    "dirname",
    "uname",
    "id",
    "env",
    "readlink",
    "cat",
    "ls",
    "rm",
    "mkdir",
    "test",
    "bash",
    "sh",
    "true",
    "false",
    "sed",
    "grep",
    "cut",
    "sort",
    "head",
    "tail",
    "find",
  ]) {
    const source = NodePath.join("/usr/bin", binary),
      target = NodePath.join(tools, binary);
    if (NodeFS.existsSync(source) && !NodeFS.existsSync(target)) NodeFS.symlinkSync(source, target);
  }
  const nodeTool = NodePath.join(tools, "node");
  if (!NodeFS.existsSync(nodeTool)) NodeFS.symlinkSync(process.execPath, nodeTool);
  if (machine.scope === "system") {
    const node = NodePath.join(machine.home, "bin/node26");
    NodeFS.writeFileSync(
      machine.node,
      `#!/bin/sh\nif [ "$(/usr/bin/id -u)" != 0 ]; then exec /usr/bin/sudo -n "$0" "$@"; fi\nexec /usr/bin/env PATH=${quote(tools)} HOME=${quote(agentHome)} ${quote(node)} "$@"\n`,
      { mode: 0o755 },
    );
  }
  const directory = NodePath.join(machine.runtimeDir, "delivery/bed-baseline");
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const existing = NodeChildProcess.spawnSync("systemctl", [
    ...prefix,
    "is-active",
    "--quiet",
    machine.unit,
  ]);
  if (existing.status === 0) control("stop", machine.unit);
  runSyncCommand("tar", ["xzf", archive, "-C", directory, "--strip-components=1"]);
  const binary = NodePath.join(directory, "t3");
  if (!NodeFS.existsSync(binary)) throw new Error("Fixture archive has no t3 executable");
  const port = Number(new URL(machine.origin).port);
  NodeFS.writeFileSync(
    machine.unitPath,
    `[Unit]\nDescription=Delivery bed isolated service ${machine.name}\n[Service]\nType=simple\nWorkingDirectory=${agentHome}\nUnsetEnvironment=T3CODE_HOME T3_BOOT_SERVICE_UNIT T3_SERVICE_LAUNCHER_CONTEXT\nEnvironment=HOME=${agentHome}\nEnvironment=PATH=${tools}\nEnvironment=T3_MESH_SSH_HOME=${agentHome}\nEnvironment=T3_MESH_AGENT_HOME=${agentHome}\nEnvironment=T3_MESH_SSHD_DIR=${sshDir}\nEnvironment=T3_MESH_TEST_MODE=1\nExecStart=${binary} serve --base-dir ${machine.home} --host 127.0.0.1 --port ${port} --no-browser\nKillMode=mixed\nStandardOutput=append:${machine.home}/serve.log\nStandardError=append:${machine.home}/serve.log\n`,
    { mode: 0o600 },
  );
  const sshUnit = machine.unit.replace(/\.service$/, "-sshd.service");
  NodeFS.writeFileSync(
    NodePath.join(NodePath.dirname(machine.unitPath), sshUnit),
    `[Unit]\nDescription=Delivery bed isolated SSH daemon\n[Service]\nExecStart=/usr/sbin/sshd -D -e -f ${sshConfig}\nStandardOutput=append:${machine.home}/sshd.log\nStandardError=append:${machine.home}/sshd.log\n`,
    { mode: 0o600 },
  );
  control("daemon-reload");
  control("start", sshUnit);
  control("start", machine.unit);
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(new URL("/.well-known/t3/environment", machine.origin), {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Fixture HTTP readiness returned ${response.status}`);
      await response.json();
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await NodeTimersPromises.setTimeout(200);
    }
  }
  console.log(
    JSON.stringify({
      fixture: machine.name,
      scope: machine.scope,
      port,
      sshdPort: machine.sshdPort,
    }),
  );
}
