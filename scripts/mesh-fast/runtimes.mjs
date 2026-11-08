import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import { run } from "./client.mjs";
import { productRoot as repo } from "./paths.mjs";
const generated = ["apps/marketing/.astro", "apps/mobile/.generated"];
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
    if (
      ["scripts/mesh-fast", "scripts/mesh-e2e", ...generated].includes(
        NodePath.relative(repo, file),
      )
    )
      continue;
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
  process.env.RAYON_NUM_THREADS = String(
    Math.max(1, Math.min(32, Math.floor(NodeOS.availableParallelism() / 4))),
  );
  const started = performance.now();
  const phases = [];
  async function measured(name, work) {
    const start = performance.now();
    try {
      return await work();
    } finally {
      phases.push({ name, seconds: (performance.now() - start) / 1000 });
    }
  }
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
  await measured("monitor", () =>
    run("bash", [new URL("build-monitor.sh", import.meta.url).pathname, cache], { cwd: repo }),
  );
  await NodeFSP.rm(root, { recursive: true, force: true });
  await NodeFSP.mkdir(root, { recursive: true });
  const webBuild = measured("web", () =>
    run("pnpm", ["--dir", "apps/web", "-s", "build"], { cwd: repo }),
  );
  const prepareNative = async () => {
    const source = NodePath.join(root, "source");
    await measured("copy-source", () =>
      NodeFSP.cp(repo, source, {
        recursive: true,
        filter: (file) => {
          const relative = NodePath.relative(repo, file);
          const parts = relative.split(NodePath.sep);
          return (
            !generated.includes(relative) &&
            !parts.some((part) =>
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
            )
          );
        },
      }),
    );
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
    const rolloutSource = NodePath.join(source, "apps/server/src/mesh/MeshRollout.ts");
    const rolloutText = await NodeFSP.readFile(rolloutSource, "utf8");
    const productionLayer = "export const layer = Layer.effect(MeshRollout, make(Effect.void));";
    if (!rolloutText.includes(productionLayer)) throw Error("MeshRollout test-layer seam changed");
    await NodeFSP.writeFile(
      rolloutSource,
      rolloutText.replace(
        productionLayer,
        `export const layer = Layer.effect(MeshRollout, make(Effect.gen(function* () {
      const environment = yield* HostProcess.Environment;
      if (environment.T3_MESH_TEST_FAIL_HEALTH_VERSION === packageJson.version) return yield* new MeshConfigError({ reason: "storage", message: "Injected mesh rollout health failure" });
    })));`,
      ),
    );
    await NodeFSP.writeFile(
      rolloutSource,
      (await NodeFSP.readFile(rolloutSource, "utf8")).replace(
        "Effect.retry({ schedule: Schedule.spaced(meshMillis(500)), times: 180 })",
        'Effect.tapError(error => Effect.logWarning("Fast rollout health pending", error)), Effect.retry({ schedule: Schedule.spaced(meshMillis(500)), times: 180 })',
      ),
    );
    const monitor = NodePath.join(root, "monitor");
    await NodeFSP.mkdir(monitor);
    await NodeFSP.copyFile(
      NodePath.join(repo, "native/resource-monitor/target/release/t3-resource-monitor"),
      NodePath.join(monitor, "t3-resource-monitor"),
    );
    const manifest = NodePath.join(source, "apps/server/package.json"),
      original = JSON.parse(await NodeFSP.readFile(manifest, "utf8"));
    const versions = ["0.1.5", "0.1.6"];
    const builds = await Promise.allSettled(
      versions.map(async (version) => {
        const versionSource = NodePath.join(root, "source-" + version);
        await measured("copy-" + version, () =>
          run("cp", ["-a", "--reflink=auto", source, versionSource]),
        );
        await NodeFSP.writeFile(
          NodePath.join(versionSource, "apps/server/package.json"),
          JSON.stringify({ ...original, version }, null, 2),
        );
        await measured("pack-" + version, () =>
          run(NodePath.join(repo, "node_modules/.bin/vp"), ["pack"], {
            cwd: NodePath.join(versionSource, "apps/server"),
            env: { ...process.env, T3CODE_PACK_EXE: "1", T3CODE_MESH_TEST_BUILD: "1" },
          }),
        );
        await webBuild;
        await NodeFSP.mkdir(NodePath.join(versionSource, "apps/server/dist"), { recursive: true });
        await NodeFSP.cp(
          NodePath.join(repo, "apps/web/dist"),
          NodePath.join(versionSource, "apps/server/dist/client"),
          { recursive: true },
        );
        const releases = NodePath.join(root, "v" + version);
        await NodeFSP.mkdir(releases);
        await measured("archive-" + version, () =>
          run(
            process.execPath,
            [
              NodePath.join(versionSource, "scripts/build-cli-archive.ts"),
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
              cwd: versionSource,
              env: {
                ...process.env,
                GZIP: "-1",
                PATH:
                  NodePath.join(repo, "node_modules/.bin") + NodePath.delimiter + process.env.PATH,
              },
            },
          ),
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
        if (version === "0.1.6")
          await NodeFSP.copyFile(
            NodePath.join(versionSource, "apps/server/dist-exe/bin.mjs"),
            NodePath.join(root, "0.1.6/bin.mjs"),
          );
      }),
    );
    await NodeFSP.writeFile(
      NodePath.join(root, "preparation.json"),
      JSON.stringify({ seconds: (performance.now() - started) / 1000, phases }, null, 2),
    );
    const failed = builds.filter((build) => build.status === "rejected");
    if (failed.length)
      throw new AggregateError(
        failed.map((build) => build.reason),
        "Native fixture builds failed",
      );
    await measured("remove-source", () =>
      run("rm", [
        "-rf",
        "--",
        source,
        ...versions.map((version) => NodePath.join(root, "source-" + version)),
      ]),
    );
    await run(process.execPath, [NodePath.join(root, "0.1.6/bin.mjs"), "--help"], {
      env: { ...process.env, NODE_COMPILE_CACHE: NodePath.join(root, "compile-cache") },
    });
    await NodeFSP.writeFile(
      NodePath.join(root, "preparation.json"),
      JSON.stringify(
        {
          seconds: (performance.now() - started) / 1000,
          bundlerWorkers: Number(process.env.RAYON_NUM_THREADS),
          phases,
        },
        null,
        2,
      ),
    );
    await NodeFSP.writeFile(NodePath.join(root, "ready"), "ready");
    return root;
  };
  const prepared = await Promise.allSettled([webBuild, prepareNative()]);
  const errors = prepared
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, "Fixture preparation failed");
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
