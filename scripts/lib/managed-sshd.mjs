import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** OpenSSH configuration shared by every isolated fixture daemon. */
export async function writeManagedSshdConfig({
  home,
  port,
  directory = NodePath.join(home, "sshd"),
  keyPath = NodePath.join(directory, "ssh_host_ed25519_key"),
  pidPath = NodePath.join(directory, "sshd.pid"),
  authorizedKeysFile = NodePath.join(home, ".ssh/authorized_keys"),
  allowUsers = NodeOS.userInfo().username,
  usePam = true,
  quotePaths = false,
  toSshPath = (value) => value,
  extraLines = [],
}) {
  if (!NodePath.isAbsolute(home)) throw new Error("Managed sshd needs an absolute fixture home");
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Managed sshd needs a private port between 1024 and 65535");
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  await NodeFSP.mkdir(NodePath.join(NodePath.dirname(authorizedKeysFile)), {
    recursive: true,
    mode: 0o700,
  });
  if (!NodeFS.existsSync(keyPath))
    NodeChildProcess.execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  const path = (value) => {
    const text = toSshPath(value);
    return quotePaths ? JSON.stringify(text) : text;
  };
  const config = [
    `Port ${port}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${path(keyPath)}`,
    `PidFile ${path(pidPath)}`,
    `AuthorizedKeysFile ${path(authorizedKeysFile)}`,
    "StrictModes no",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PubkeyAuthentication yes",
    ...(usePam ? ["UsePAM no"] : []),
    "UseDNS no",
    "PermitUserRC no",
    "PermitUserEnvironment no",
    ...(allowUsers ? [`AllowUsers ${allowUsers}`] : []),
    "Subsystem sftp internal-sftp",
    ...extraLines,
  ].join("\n");
  const configPath = NodePath.join(directory, "sshd_config");
  await NodeFSP.writeFile(configPath, `${config}\n`, { mode: 0o600 });
  return configPath;
}
