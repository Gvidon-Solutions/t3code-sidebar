import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";

const [home, portText] = process.argv.slice(2);
const port = Number(portText);
if (!home || !NodePath.isAbsolute(home) || !Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("Usage: managed-sshd.mjs ABSOLUTE_SSH_HOME PORT");
const directory = NodePath.join(home, "sshd");
await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
await NodeFSP.mkdir(NodePath.join(home, ".ssh"), { recursive: true, mode: 0o700 });
const key = NodePath.join(directory, "ssh_host_ed25519_key");
try {
  await NodeFSP.stat(key);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  NodeChildProcess.execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
}
const config = `Port ${port}
ListenAddress 127.0.0.1
HostKey ${key}
PidFile ${directory}/sshd.pid
AuthorizedKeysFile ${home}/.ssh/authorized_keys
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
AllowUsers ${NodeOS.userInfo().username}
Subsystem sftp internal-sftp
`;
await NodeFSP.writeFile(NodePath.join(directory, "sshd_config"), config, { mode: 0o600 });
console.log(NodePath.join(directory, "sshd_config"));
