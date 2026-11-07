#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
const run = (command, args, options = {}) =>
  NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const assertMachine = (machine) => {
  if (
    !/^D1-[a-z-]+\.service$/.test(machine.unit) ||
    NodePath.basename(machine.unitPath) !== machine.unit
  )
    throw new Error("Bed setup only manages D1-prefixed isolated units");
  if (!Number.isInteger(machine.sshdPort) || machine.sshdPort < 1024)
    throw new Error("Set a private sshdPort for each fixture");
};

const { machine, archive, lockFile, lockOwner } = JSON.parse(NodeFS.readFileSync(0, "utf8"));
assertMachine(machine);
const checkLock = () => {
  if (lockFile && NodeFS.readFileSync(lockFile, "utf8").trim() !== lockOwner)
    throw new Error("The delivery fixture no longer owns the bed lock");
};
checkLock();
const marker = NodePath.join(machine.home, "D1-fixture-owned.json");
if (
  NodeFS.existsSync(NodePath.join(machine.home, "userdata/statev2.sqlite")) &&
  !NodeFS.existsSync(marker)
)
  throw new Error("Refusing a pre-existing non-fixture T3 database");
NodeFS.mkdirSync(machine.home, { recursive: true, mode: 0o700 });
NodeFS.writeFileSync(marker, JSON.stringify({ fixture: "D1 delivery", unit: machine.unit }), {
  mode: 0o600,
});
const agentHome = NodePath.join(machine.home, "agent-home");
const sshDir = NodePath.join(agentHome, "sshd");
NodeFS.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
NodeFS.mkdirSync(NodePath.join(agentHome, ".ssh"), { recursive: true, mode: 0o700 });
const key = NodePath.join(sshDir, "ssh_host_ed25519_key");
if (!NodeFS.existsSync(key)) run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
const sshConfig = NodePath.join(sshDir, "sshd_config");
NodeFS.writeFileSync(
  sshConfig,
  `Port ${machine.sshdPort}\nListenAddress 127.0.0.1\nHostKey ${key}\nPidFile ${sshDir}/sshd.pid\nAuthorizedKeysFile ${agentHome}/.ssh/authorized_keys\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM no\nAllowUsers ${NodeOS.userInfo().username}\nSubsystem sftp internal-sftp\n`,
  { mode: 0o600 },
);
const prefix = machine.scope === "user" ? ["--user"] : [];
const control = (...args) => {
  checkLock();
  return run("systemctl", [...prefix, ...args]);
};
const tools = NodePath.join(machine.home, "tools");
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
if (machine.scope === "system") {
  const node = NodePath.join(machine.home, "bin/node26");
  NodeFS.writeFileSync(
    machine.node,
    `#!/bin/sh\nif [ "$(/usr/bin/id -u)" != 0 ]; then exec /usr/bin/sudo -n "$0" "$@"; fi\nexec /usr/bin/env PATH=${quote(tools)} HOME=${quote(agentHome)} ${quote(node)} "$@"\n`,
    { mode: 0o755 },
  );
}
const directory = NodePath.join(machine.runtimeDir, "delivery/D1-baseline");
NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
const existing = NodeChildProcess.spawnSync("systemctl", [
  ...prefix,
  "is-active",
  "--quiet",
  machine.unit,
]);
if (existing.status === 0) control("stop", machine.unit);
run("tar", ["xzf", archive, "-C", directory, "--strip-components=1"]);
const binary = NodePath.join(directory, "t3");
if (!NodeFS.existsSync(binary)) throw new Error("Fixture archive has no t3 executable");
const port = Number(new URL(machine.origin).port);
NodeFS.writeFileSync(
  machine.unitPath,
  `[Unit]\nDescription=D1 isolated delivery ${machine.name}\n[Service]\nType=simple\nWorkingDirectory=${agentHome}\nEnvironment=HOME=${agentHome}\nEnvironment=PATH=${tools}\nEnvironment=T3_MESH_SSH_HOME=${agentHome}\nEnvironment=T3_MESH_AGENT_HOME=${agentHome}\nEnvironment=T3_MESH_SSHD_DIR=${sshDir}\nEnvironment=T3_MESH_TEST_MODE=1\nExecStart=${binary} serve --base-dir ${machine.home} --host 127.0.0.1 --port ${port} --no-browser\nKillMode=mixed\nStandardOutput=append:${machine.home}/serve.log\nStandardError=append:${machine.home}/serve.log\n`,
  { mode: 0o600 },
);
const sshUnit = machine.unit.replace(/\.service$/, "-sshd.service");
NodeFS.writeFileSync(
  NodePath.join(NodePath.dirname(machine.unitPath), sshUnit),
  `[Unit]\nDescription=D1 isolated SSH daemon\n[Service]\nExecStart=/usr/sbin/sshd -D -e -f ${sshConfig}\nStandardOutput=append:${machine.home}/sshd.log\nStandardError=append:${machine.home}/sshd.log\n`,
  { mode: 0o600 },
);
control("daemon-reload");
control("start", sshUnit);
control("start", machine.unit);
console.log(
  JSON.stringify({ fixture: machine.name, scope: machine.scope, port, sshdPort: machine.sshdPort }),
);
