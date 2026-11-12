import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import { run } from "./client.mjs";
import { posixLockBinary } from "./daemons.mjs";
async function prepareLocked() {
  const root =
    process.env.MESH_FAST_MUTAGEN_CACHE ?? NodePath.join(NodeOS.tmpdir(), "mesh-fast-tools-0.18.1");
  await NodeFSP.mkdir(root, { recursive: true });
  await posixLockBinary(root);
  const pnpm = NodePath.join(root, "pnpm-12.14.0");
  let pnpmReady = false;
  try {
    await NodeFSP.stat(NodePath.join(pnpm, ".mesh-fast-ready"));
    pnpmReady = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!pnpmReady) {
    const response = await fetch("https://registry.npmjs.org/pnpm/-/pnpm-12.14.0.tgz");
    if (!response.ok) throw Error("pnpm fixture download: " + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      NodeCrypto.createHash("sha512").update(bytes).digest("base64") !==
      "wYum2HmT09Fky16JSPMrLAbuhUSH4GzY2GeBNC+z5btGNDZwNHEehoArqpw3vqkGzhkprQjXCITJfYAd8TOJpg=="
    )
      throw Error("pnpm fixture checksum mismatch");
    const archive = NodePath.join(root, "pnpm-12.14.0.tgz");
    await NodeFSP.writeFile(archive, bytes);
    await NodeFSP.mkdir(pnpm, { recursive: true });
    await run("tar", ["-xzf", archive, "--strip-components=1", "-C", pnpm]);
    const native = await fetch(
      "https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.14.0.tgz",
    );
    if (!native.ok) throw Error("pnpm native fixture download: " + native.status);
    const executable = Buffer.from(await native.arrayBuffer());
    if (
      NodeCrypto.createHash("sha512").update(executable).digest("base64") !==
      "F6K8e/jWxiuEYJaQtRRUG9ynBSTEHa+t7Lf86MKuOO5UA7WVVMbi+oB8nY6iKW++ncWS2yG6T9faXZGxqNsfoQ=="
    )
      throw Error("pnpm native fixture checksum mismatch");
    const nativeArchive = NodePath.join(root, "pnpm-native-12.14.0.tgz");
    await NodeFSP.writeFile(nativeArchive, executable);
    await run("tar", ["-xzf", nativeArchive, "--strip-components=1", "-C", pnpm, "package/pnpm"]);
    await NodeFSP.writeFile(NodePath.join(pnpm, ".mesh-fast-ready"), "12.14.0\n");
  }
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
  try {
    await NodeFSP.stat(archive);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await NodeFSP.writeFile(archive, bytes);
  }
  const ready = NodePath.join(root, "tools-ready");
  try {
    await NodeFSP.stat(ready);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await run("tar", ["-xzf", archive, "-C", root]);
    await NodeFSP.writeFile(ready, "0.18.1\n");
  }
  // The runner launches web tests through playwright-core, whose browser revision changes with
  // the dependency. Install it beside the other tools instead of relying on a global cache.
  const browsers = NodePath.join(root, "browsers");
  const playwrightRoot = NodePath.dirname(
    NodeURL.fileURLToPath(import.meta.resolve("playwright-core")),
  );
  const playwrightCli = NodePath.join(playwrightRoot, "cli.js");
  const playwrightVersion = JSON.parse(
    await NodeFSP.readFile(NodePath.join(playwrightRoot, "package.json"), "utf8"),
  ).version;
  const playwrightReady = NodePath.join(browsers, `.mesh-fast-playwright-${playwrightVersion}`);
  let browsersReady = false;
  try {
    await NodeFSP.stat(playwrightReady);
    browsersReady = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!browsersReady) {
    await NodeFSP.mkdir(browsers, { recursive: true });
    await run(process.execPath, [playwrightCli, "install", "chromium"], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
    });
    await NodeFSP.writeFile(playwrightReady, `${playwrightVersion}\n`);
  }
  await run("docker", [
    "build",
    "-t",
    "mesh-fast-node:26",
    "-f",
    new URL("Dockerfile", import.meta.url).pathname,
    new URL(".", import.meta.url).pathname,
  ]);
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

export async function prepare() {
  const root =
    process.env.MESH_FAST_MUTAGEN_CACHE ?? NodePath.join(NodeOS.tmpdir(), "mesh-fast-tools-0.18.1");
  await NodeFSP.mkdir(root, { recursive: true });
  return run(
    "flock",
    [
      NodePath.join(root, "prepare.lock"),
      process.execPath,
      new URL(import.meta.url).pathname,
      "--prepare",
    ],
    { env: { ...process.env, MESH_FAST_MUTAGEN_CACHE: root } },
  );
}
if (import.meta.main && process.argv[2] === "--prepare") console.log(await prepareLocked());
