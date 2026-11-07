import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { run } from "./client.mjs";
export async function previous(cache) {
  const revision = "360c04261b9d3bf129dcf59d9efba1a56d5b242c";
  const directory = NodePath.join(cache, "previous-" + revision);
  try {
    await NodeFSP.stat(NodePath.join(directory, ".mesh-fast-ready"));
    return NodePath.join(directory, "apps/server/src/bin.ts");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const archive = NodePath.join(cache, "previous-62-source.tgz");
  let bytes;
  try {
    bytes = await NodeFSP.readFile(archive);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!bytes) {
    const response = await fetch(
      `https://codeload.github.com/Gvidon-Solutions/t3code-sidebar/tar.gz/${revision}`,
    );
    if (!response.ok) throw Error("Previous release source: " + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
    await NodeFSP.writeFile(archive, bytes);
  }
  if (
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !==
    "4f1920c0258fd43210494429c788021b25a39b9a8e30483e65229956d45df9b8"
  )
    throw Error("Previous release snapshot checksum mismatch");
  await NodeFSP.mkdir(directory, { recursive: true });
  await run("tar", ["-xzf", archive, "--strip-components=1", "-C", directory]);
  await run("pnpm", ["install", "--frozen-lockfile"], {
    cwd: directory,
    env: { ...process.env, CI: "1" },
  });
  await NodeFSP.writeFile(NodePath.join(directory, ".mesh-fast-ready"), revision);
  return NodePath.join(directory, "apps/server/src/bin.ts");
}
