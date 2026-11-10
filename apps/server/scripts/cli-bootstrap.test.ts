// @effect-diagnostics nodeBuiltinImport:off -- Reproduces the single-executable bootstrap build on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite-plus/pack";
import { expect, it } from "vite-plus/test";

const appsServer = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const BOOTSTRAP_LIMIT = 1024 * 1024;

it("keeps the executable bootstrap under the service launcher's 1 MiB limit", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cli-bootstrap-"));
  const previousPack = process.env.T3CODE_PACK_EXE;
  const previousAssets = process.env.T3CODE_CLI_ASSET_DIR;
  process.env.T3CODE_PACK_EXE = "bootstrap";
  process.env.T3CODE_CLI_ASSET_DIR = NodePath.join(root, "assets");
  await NodeFSP.mkdir(process.env.T3CODE_CLI_ASSET_DIR);
  try {
    // The real build config, so a new slow import into bin.ts fails here before CI's build-exe.
    const config = (await import("../vite.config.ts")).default;
    if (!config.pack) throw new Error("The server config defines no pack section.");
    const outDir = NodePath.join(root, "out");
    await build({ cwd: appsServer, ...config.pack, outDir, clean: true });

    const bootstrapPath = NodePath.join(outDir, "bin.mjs");
    const bytes = (await NodeFSP.stat(bootstrapPath)).size;
    expect(bytes).toBeLessThanOrEqual(BOOTSTRAP_LIMIT);
  } finally {
    if (previousPack === undefined) delete process.env.T3CODE_PACK_EXE;
    else process.env.T3CODE_PACK_EXE = previousPack;
    if (previousAssets === undefined) delete process.env.T3CODE_CLI_ASSET_DIR;
    else process.env.T3CODE_CLI_ASSET_DIR = previousAssets;
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
