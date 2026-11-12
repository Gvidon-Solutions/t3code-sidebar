// @effect-diagnostics nodeBuiltinImport:off - Verifies the canonical artifacts root used by run.mjs.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { createRunRoot, prepareArtifactsDirectory } from "./run-root.mjs";

it("canonicalizes a symlinked artifacts directory before creating the run root", async () => {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-run-root-"));
  const target = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-run-target-"));
  try {
    const link = NodePath.join(base, "artifacts");
    await NodeFSP.symlink(target, link);
    const canonicalTarget = await NodeFSP.realpath(target);
    const { artifactsDirectory, root } = await createRunRoot(link);

    expect(artifactsDirectory).toBe(canonicalTarget);
    expect(artifactsDirectory).not.toBe(link);
    expect(root.startsWith(canonicalTarget + NodePath.sep)).toBe(true);
    expect((await NodeFSP.stat(root)).isDirectory()).toBe(true);

    // Mirrors the runner.json the CLI writes with the reported host paths.
    const runner = NodePath.join(root, "runner.json");
    await NodeFSP.writeFile(runner, JSON.stringify({ artifactsDirectory }));
    expect(JSON.parse(await NodeFSP.readFile(runner, "utf8")).artifactsDirectory).toBe(
      canonicalTarget,
    );
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
    await NodeFSP.rm(target, { recursive: true, force: true });
  }
});

it("creates a missing artifacts root and reports its canonical path", async () => {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-run-create-"));
  try {
    const directory = NodePath.join(base, "nested", "artifacts");
    const canonical = await prepareArtifactsDirectory(directory);
    expect(canonical).toBe(await NodeFSP.realpath(directory));
    expect((await NodeFSP.stat(canonical)).isDirectory()).toBe(true);
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
});
