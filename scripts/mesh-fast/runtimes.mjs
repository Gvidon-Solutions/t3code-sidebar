import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import { run } from "./client.mjs";
const repo = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
async function fingerprint(directory, hash) {
  for (const entry of (await NodeFSP.readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (
      [
        "node_modules",
        ".git",
        ".repos",
        "target",
        "dist",
        "dist-exe",
        ".t3",
        ".vite-plus",
        ".vite",
      ].includes(entry.name)
    )
      continue;
    const file = NodePath.join(directory, entry.name);
    if (["scripts/mesh-fast", "scripts/mesh-e2e"].includes(NodePath.relative(repo, file))) continue;
    if (entry.isDirectory()) await fingerprint(file, hash);
    else if (
      entry.isFile() &&
      !/\.(?:test|spec)\./.test(file) &&
      (/\.([cm]?[jt]sx?|css|svg|jsonc?|ya?ml|rs|lock|toml|sh|woff2?|ttf)$/.test(file) ||
        NodePath.relative(repo, file).startsWith("agent-kit/") ||
        NodePath.relative(repo, file).startsWith("apps/web/public/"))
    )
      hash.update(NodePath.relative(repo, file)).update(await NodeFSP.readFile(file));
  }
}
async function buildRuntimes(cache) {
  const hash = NodeCrypto.createHash("sha256");
  await fingerprint(repo, hash);
  hash.update(await NodeFSP.readFile(new URL(import.meta.url)));
  const root = NodePath.join(cache, "runtimes-" + hash.digest("hex").slice(0, 16));
  try {
    await NodeFSP.stat(NodePath.join(root, "ready"));
    return root;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await run("bash", [new URL("build-monitor.sh", import.meta.url).pathname, cache], { cwd: repo });
  await run("pnpm", ["--dir", "apps/web", "-s", "build"], { cwd: repo });
  await NodeFSP.rm(root, { recursive: true, force: true });
  await NodeFSP.mkdir(root, { recursive: true });
  const source = NodePath.join(root, "source");
  await NodeFSP.cp(repo, source, {
    recursive: true,
    filter: (file) =>
      !NodePath.relative(repo, file)
        .split(NodePath.sep)
        .some((part) =>
          [
            "node_modules",
            ".git",
            ".repos",
            "target",
            "dist",
            "dist-exe",
            ".t3",
            ".vite-plus",
            ".vite",
          ].includes(part),
        ),
  });
  for (const parent of [
    "",
    "scripts",
    ...(await NodeFSP.readdir(NodePath.join(repo, "apps")).then((names) =>
      names.map((name) => "apps/" + name),
    )),
    ...(await NodeFSP.readdir(NodePath.join(repo, "packages")).then((names) =>
      names.map((name) => "packages/" + name),
    )),
  ]) {
    try {
      await NodeFSP.stat(NodePath.join(repo, parent, "node_modules"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    await NodeFSP.mkdir(NodePath.join(source, parent), { recursive: true });
    await NodeFSP.symlink(
      NodePath.join(repo, parent, "node_modules"),
      NodePath.join(source, parent, "node_modules"),
    );
  }
  await NodeFSP.mkdir(NodePath.join(source, "apps/server/dist"), { recursive: true });
  await NodeFSP.cp(
    NodePath.join(repo, "apps/web/dist"),
    NodePath.join(source, "apps/server/dist/client"),
    { recursive: true },
  );
  const monitor = NodePath.join(root, "monitor");
  await NodeFSP.mkdir(monitor);
  await NodeFSP.copyFile(
    NodePath.join(repo, "native/resource-monitor/target/release/t3-resource-monitor"),
    NodePath.join(monitor, "t3-resource-monitor"),
  );
  const manifest = NodePath.join(source, "apps/server/package.json"),
    original = JSON.parse(await NodeFSP.readFile(manifest, "utf8"));
  for (const version of ["0.1.5", "0.1.6"]) {
    await NodeFSP.writeFile(manifest, JSON.stringify({ ...original, version }, null, 2));
    await run(NodePath.join(repo, "node_modules/.bin/vp"), ["pack"], {
      cwd: NodePath.join(source, "apps/server"),
      env: { ...process.env, T3CODE_PACK_EXE: "1", T3CODE_MESH_TEST_BUILD: "1" },
    });
    const releases = NodePath.join(root, "v" + version);
    await NodeFSP.mkdir(releases);
    await run(
      process.execPath,
      [
        NodePath.join(source, "scripts/build-cli-archive.ts"),
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        version,
        "--output-dir",
        releases,
        "--resource-monitor-dir",
        monitor,
      ],
      {
        cwd: source,
        env: {
          ...process.env,
          PATH: NodePath.join(repo, "node_modules/.bin") + NodePath.delimiter + process.env.PATH,
        },
      },
    );
    const filename = `t3-${version}-linux-x64.tar.gz`,
      bytes = await NodeFSP.readFile(NodePath.join(releases, filename));
    await NodeFSP.writeFile(
      NodePath.join(releases, "SHA256SUMS"),
      NodeCrypto.createHash("sha256").update(bytes).digest("hex") + "  " + filename + "\n",
    );
    const extracted = NodePath.join(root, version);
    await NodeFSP.mkdir(extracted);
    await run("tar", [
      "-xzf",
      NodePath.join(releases, filename),
      "--strip-components=1",
      "-C",
      extracted,
    ]);
    await NodeFSP.writeFile(
      NodePath.join(extracted, ".mesh-fast-fixture"),
      "Test build; never publish\n",
    );
  }
  await NodeFSP.writeFile(NodePath.join(root, "ready"), "ready");
  return root;
}

export async function runtimes(cache) {
  return run("flock", [
    NodePath.join(cache, "runtimes.lock"),
    process.execPath,
    new URL(import.meta.url).pathname,
    "--build",
    cache,
  ]);
}
if (process.argv[2] === "--build") console.log(await buildRuntimes(process.argv[3]));
