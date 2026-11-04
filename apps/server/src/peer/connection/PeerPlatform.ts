// @effect-diagnostics nodeBuiltinImport:off -- System SSH paths and private local sockets are the peer transport's platform boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const sshDirectory = (platform: NodeJS.Platform, environment: NodeJS.ProcessEnv) =>
  platform === "win32"
    ? NodePath.win32.join(environment.ProgramData ?? "C:\\ProgramData", "ssh")
    : "/etc/ssh";

export const pipeAddress = (
  baseDir: string,
  platform: NodeJS.Platform,
  userId: number | undefined,
) => {
  const hash = NodeCrypto.createHash("sha256")
    .update(NodePath.resolve(baseDir))
    .digest("hex")
    .slice(0, 24);
  return platform === "win32"
    ? `\\\\.\\pipe\\t3-mesh-${hash}`
    : NodePath.join(NodeOS.tmpdir(), `t3-mesh-${userId}`, `${hash}.sock`);
};

export async function preparePipeAddress(
  address: string,
  platform: NodeJS.Platform,
  userId: number | undefined,
) {
  if (platform === "win32") return;
  if (userId === undefined) throw new Error("A Unix user id is required for the local mesh socket");
  const directory = NodePath.dirname(address);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== userId || (stat.mode & 0o077) !== 0)
    throw new Error("Local mesh pipe directory is not private");
  try {
    await NodeFSP.unlink(address);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export async function securePipeAddress(address: string, platform: NodeJS.Platform) {
  if (platform !== "win32") await NodeFSP.chmod(address, 0o600);
}
