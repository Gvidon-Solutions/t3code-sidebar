#!/usr/bin/env node
import { runSync as run, quote } from "../lib/shell.mjs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { readConfig } from "./builder.mjs";

const targetSource = NodeURL.fileURLToPath(new URL("./bed-target.mjs", import.meta.url));
const scripts = NodeURL.fileURLToPath(
  new URL("../../agent-kit/skills/t3/scripts/", import.meta.url),
);
const assertMachine = (machine) => {
  if (
    !/^D1-[a-z-]+\.service$/.test(machine.unit) ||
    NodePath.basename(machine.unitPath) !== machine.unit
  )
    throw new Error("Bed setup only manages D1-prefixed isolated units");
  if (!Number.isInteger(machine.sshdPort) || machine.sshdPort < 1024)
    throw new Error("Set a private sshdPort for each fixture");
};
const { values } = NodeUtil.parseArgs({
  options: {
    config: { type: "string" },
    archive: { type: "string" },
    "bed-lock-file": { type: "string" },
    "bed-lock-owner": { type: "string", default: "D1" },
  },
});
if (!values.config || !values.archive)
  throw new Error(
    "Usage: node bed-setup.mjs --config PRIVATE.json --archive BASELINE.tar.gz --bed-lock-file /tmp/mesh-bed.lock/owner",
  );
const config = readConfig(values.config);
const archive = NodePath.resolve(values.archive);
for (const machine of config.machines) {
  assertMachine(machine);
  const input = { machine, archive, lockFile: null, lockOwner: values["bed-lock-owner"] };
  if (machine.ssh) {
    if (!values["bed-lock-file"])
      throw new Error("Remote fixture setup requires the shared bed lock");
    const ssh = (command, options) =>
      run(
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
      run("scp", [...(machine.scpArgs ?? []), source, `${machine.ssh}:${dest}`]);
    const node = NodePath.join(binaryDir, "node26");
    upload(process.execPath, node);
    ssh(check + `chmod 0755 ${quote(node)}`);
    upload(targetSource, NodePath.join(binaryDir, "bed-target.mjs"));
    upload(
      NodeURL.fileURLToPath(new URL("../lib/shell.mjs", import.meta.url)),
      NodePath.join(lib, "shell.mjs"),
    );
    upload(NodePath.join(scripts, "t3ctl.mjs"), machine.ctl);
    upload(NodePath.join(scripts, "server-runtime.mjs"), NodePath.join(kit, "server-runtime.mjs"));
    input.archive = NodePath.join(machine.home, "D1-baseline.tar.gz");
    upload(archive, input.archive);
    input.lockFile = lock;
    const command = `${machine.scope === "system" ? "sudo -n " : ""}${quote(node)} ${quote(NodePath.join(binaryDir, "bed-target.mjs"))}`;
    console.log(ssh(check + command, { input: JSON.stringify(input) }).trim());
  } else
    console.log(run(process.execPath, [targetSource], { input: JSON.stringify(input) }).trim());
}
