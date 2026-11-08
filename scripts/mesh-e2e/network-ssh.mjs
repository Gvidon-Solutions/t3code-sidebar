#!/usr/bin/env node
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
const { spawn } = NodeChildProcess;
import * as NodeEvents from "node:events";
const { once } = NodeEvents;

import { quote } from "../lib/shell.mjs";
const [binary, baseDir, machine, user, hostKeysFile] = process.argv.slice(2);
if (!hostKeysFile)
  throw new Error("Usage: network-ssh.mjs T3_BINARY BASE_DIR MACHINE USER HOST_KEYS_JSON");
const work = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-network-ssh-"));
const key = NodePath.join(work, "identity");
const alias = "mesh-network-network-target";
const execute = (program, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${program}: ${code ?? signal}: ${stderr}`)),
    );
    child.stdin.end(input);
  });
await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
console.log(`AUTHORIZED_KEY_FILE=${key}.pub`);
console.log(`WORK=${work}`);
if (process.env.MESH_E2E_SSH_PREPARE_ONLY === "1") process.exit(0);

const identity = process.env.MESH_E2E_SSH_IDENTITY ?? key;
const keys = JSON.parse(await NodeFSP.readFile(hostKeysFile, "utf8"));
if (!Array.isArray(keys) || keys.length === 0) throw new Error("Peer reported no SSH host keys");
const known = NodePath.join(work, "known_hosts");
await NodeFSP.writeFile(known, keys.map((publicKey) => `${alias} ${publicKey}\n`).join(""), {
  mode: 0o600,
});
const options = [
  "-F",
  "/dev/null",
  "-i",
  identity,
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  `UserKnownHostsFile=${known}`,
  "-o",
  `ProxyCommand=${quote(binary)} mesh pipe ${quote(machine)} --base-dir ${quote(baseDir)}`,
  `${user}@${alias}`,
];
const ssh = (command, input) => execute("ssh", [...options, command], input);
await ssh("true");
console.log("PASS SSH ProxyCommand with pinned peer-reported host keys");
const block = Buffer.alloc(1024 * 1024, 79);
const expected = NodeCrypto.createHash("sha256");
const transfer = spawn("ssh", [...options, "sha256sum"], { stdio: ["pipe", "pipe", "pipe"] });
let answer = "",
  errors = "";
transfer.stdout.setEncoding("utf8");
transfer.stderr.setEncoding("utf8");
transfer.stdout.on("data", (chunk) => {
  answer += chunk;
});
transfer.stderr.on("data", (chunk) => {
  errors += chunk;
});
const finished = once(transfer, "close");
for (let index = 0; index < 200; index++) {
  expected.update(block);
  if (!transfer.stdin.write(block)) await once(transfer.stdin, "drain");
}
transfer.stdin.end();
const [code] = await finished;
if (code !== 0 || !answer.startsWith(expected.digest("hex")))
  throw new Error(`200 MiB upload failed: ${code}: ${answer}: ${errors}`);
console.log("PASS 200 MiB SSH upload: SHA-256 matches");
const download = spawn("ssh", [...options, "head -c 209715200 /dev/zero"], {
  stdio: ["ignore", "pipe", "pipe"],
});
const received = NodeCrypto.createHash("sha256");
let bytes = 0;
download.stdout.on("data", (chunk) => {
  bytes += chunk.length;
  received.update(chunk);
});
let downloadError = "";
download.stderr.on("data", (chunk) => {
  downloadError += chunk;
});
const [downloadCode] = await once(download, "close");
const zeroHash = NodeCrypto.createHash("sha256");
for (let index = 0; index < 200; index++) zeroHash.update(Buffer.alloc(1024 * 1024));
if (downloadCode !== 0 || bytes !== 209715200 || received.digest("hex") !== zeroHash.digest("hex"))
  throw new Error(`200 MiB download failed: ${downloadCode}, ${bytes}: ${downloadError}`);
console.log("PASS 200 MiB SSH download: byte count and SHA-256 match");
const interrupted = spawn("ssh", [...options, "cat > /tmp/mesh-network-interrupted-transfer"], {
  stdio: ["pipe", "ignore", "pipe"],
});
interrupted.stdin.on("error", (error) => {
  if (error.code !== "EPIPE") console.error(error);
});
interrupted.stderr.resume();
const interruptedExit = once(interrupted, "close");
for (let index = 0; index < 20; index++)
  if (!interrupted.stdin.write(block)) await once(interrupted.stdin, "drain");
interrupted.kill("SIGINT");
const [interruptedCode, interruptedSignal] = await interruptedExit;
if (interruptedCode === 0 && interruptedSignal === null)
  throw new Error("Interrupted SSH transfer reported success");
await ssh("true");
console.log("PASS interrupted SSH upload fails and a new SSH session succeeds");
console.log(`mesh network SSH: 4 acceptance checks passed; evidence ${work}`);
