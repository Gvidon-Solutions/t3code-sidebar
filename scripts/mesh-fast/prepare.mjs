import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import { run } from "./client.mjs";
export async function prepare() {
  const root =
    process.env.MESH_FAST_MUTAGEN_CACHE ?? NodePath.join(NodeOS.tmpdir(), "mesh-fast-tools-0.18.1");
  await NodeFSP.mkdir(root, { recursive: true });
  const archive = NodePath.join(root, "mutagen.tar.gz");
  let bytes;
  try {
    bytes = await NodeFSP.readFile(archive);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!bytes) {
    const response = await fetch(
      "https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/mutagen_linux_amd64_v0.18.1.tar.gz",
    );
    if (!response.ok) throw Error("Mutagen fixture download: " + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !==
    "7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f"
  )
    throw Error("Mutagen fixture checksum mismatch");
  await NodeFSP.writeFile(archive, bytes);
  await run("tar", ["-xzf", archive, "-C", root]);
  try {
    await run("docker", ["image", "inspect", "mesh-fast-node:26"]);
  } catch {
    await run("docker", [
      "build",
      "-t",
      "mesh-fast-node:26",
      "-f",
      new URL("Dockerfile", import.meta.url).pathname,
      new URL(".", import.meta.url).pathname,
    ]);
  }
  const agent = NodePath.join(root, "mutagen-agent-linux-amd64");
  try {
    await NodeFSP.stat(agent);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await run("tar", [
      "-xzf",
      NodePath.join(root, "mutagen-agents.tar.gz"),
      "-C",
      root,
      "linux_amd64",
    ]);
    await NodeFSP.rename(NodePath.join(root, "linux_amd64"), agent);
    await NodeFSP.chmod(agent, 0o755);
  }
  return root;
}
