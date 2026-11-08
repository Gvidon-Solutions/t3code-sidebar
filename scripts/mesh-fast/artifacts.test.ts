// @effect-diagnostics nodeBuiltinImport:off - Verifies isolated artifact filesystem cleanup.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "vite-plus/test";
import { prunePassed, pruneRuns, finishRun } from "./artifacts.mjs";
import { ownership, type Ownership } from "./lifecycle.mjs";

async function fixture(base: string, owner: Ownership, failed: boolean) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(base, "mesh-fast-"));
  await NodeFSP.writeFile(NodePath.join(directory, "runner.json"), JSON.stringify(owner));
  await NodeFSP.writeFile(
    NodePath.join(directory, "summary.json"),
    JSON.stringify({
      seconds: 1,
      budgetSeconds: 360,
      results: [{ name: "case", error: failed ? "fault" : undefined }],
    }),
  );
  await NodeFSP.writeFile(NodePath.join(directory, "junit.xml"), '<testsuite tests="1"/>');
  await NodeFSP.writeFile(NodePath.join(directory, "unmarked-payload.bin"), "fixture bytes");
  return directory;
}

it("prunes passed machine payloads while preserving diagnostics and unowned or linked data", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-artifacts-"));
  try {
    const scenario = NodePath.join(root, "case"),
      machine = NodePath.join(scenario, "studio"),
      outside = NodePath.join(root, "outside");
    await NodeFSP.mkdir(machine, { recursive: true });
    await NodeFSP.mkdir(outside);
    await NodeFSP.writeFile(NodePath.join(outside, "retained"), "owner data");
    await NodeFSP.writeFile(NodePath.join(machine, "server-spec.json"), "{}");
    await NodeFSP.writeFile(NodePath.join(machine, "server.log"), "diagnostics");
    await NodeFSP.symlink(outside, NodePath.join(machine, "home"));
    for (const payload of ["state", "runtime"]) {
      await NodeFSP.mkdir(NodePath.join(machine, payload));
      await NodeFSP.writeFile(NodePath.join(machine, payload, "data"), "private fixture data");
    }
    await NodeFSP.mkdir(NodePath.join(scenario, "unmarked", "state"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(scenario, "unmarked", "state", "data"), "retained");
    await NodeFSP.symlink(outside, NodePath.join(scenario, "linked"));
    await NodeFSP.mkdir(NodePath.join(scenario, "artifacts"));
    await NodeFSP.writeFile(NodePath.join(scenario, "artifacts", "shot.png"), "evidence");
    const bootstrap = NodePath.join(scenario, "cloudbox");
    await NodeFSP.mkdir(NodePath.join(bootstrap, "state"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(bootstrap, ".mesh-fast-node"), "bootstrap fixture");
    await NodeFSP.writeFile(NodePath.join(bootstrap, "state", "data"), "private bootstrap data");
    await prunePassed(scenario);
    for (const payload of ["home", "state", "runtime"])
      await expect(NodeFSP.lstat(NodePath.join(machine, payload))).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect(await NodeFSP.readFile(NodePath.join(machine, "server.log"), "utf8")).toBe(
      "diagnostics",
    );
    expect(await NodeFSP.readFile(NodePath.join(outside, "retained"), "utf8")).toBe("owner data");
    await expect(NodeFSP.lstat(NodePath.join(bootstrap, "state"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await NodeFSP.readFile(NodePath.join(scenario, "unmarked", "state", "data"), "utf8"),
    ).toBe("retained");
    expect(await NodeFSP.readFile(NodePath.join(scenario, "artifacts", "shot.png"), "utf8")).toBe(
      "evidence",
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("deletes complete successful runs and keeps only compact latest reports without following report symlinks", async () => {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-retention-"));
  const owner = await ownership();
  try {
    const outside = NodePath.join(base, "outside");
    await NodeFSP.writeFile(outside, "owner data");
    const first = await fixture(base, owner, false);
    await NodeFSP.writeFile(NodePath.join(first, "server.log"), "discard successful diagnostics");
    await NodeFSP.writeFile(NodePath.join(first, "recovery.json"), "{}");
    await NodeFSP.symlink(outside, NodePath.join(first, "external"));
    const reports = await finishRun(first, owner, false);
    expect(reports).toBe(NodePath.join(base, "latest"));
    await expect(NodeFSP.lstat(first)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await NodeFSP.readdir(reports)).sort()).toEqual([
      ".mesh-fast-reports.json",
      "junit.xml",
      "recovery.json",
      "retention.json",
      "runner.json",
      "summary.json",
    ]);
    await NodeFSP.rm(NodePath.join(reports, "summary.json"));
    await NodeFSP.symlink(outside, NodePath.join(reports, "summary.json"));
    const secondOwner = { ...owner, runId: NodeCrypto.randomUUID() };
    const second = await fixture(base, secondOwner, false);
    expect(await finishRun(second, secondOwner, false)).toBe(reports);
    await expect(NodeFSP.lstat(second)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(NodeFSP.lstat(NodePath.join(reports, "recovery.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await NodeFSP.lstat(NodePath.join(reports, "summary.json"))).isSymbolicLink()).toBe(
      false,
    );
    expect(await NodeFSP.readFile(outside, "utf8")).toBe("owner data");
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
});

it("retains the newest three failed runs, reclaims abandoned and legacy successful runs, and preserves active or unowned paths", async () => {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-retention-"));
  const current = await ownership();
  const dead = () => ({ ...current, start: "0", runId: NodeCrypto.randomUUID() });
  try {
    const active = await fixture(base, { ...current, runId: NodeCrypto.randomUUID() }, true);
    const foreign = await fixture(base, { ...dead(), machine: "another-host" }, true);
    const foreignUid = await fixture(base, { ...dead(), uid: current.uid + 1 }, false);
    const malformed = NodePath.join(base, "mesh-fast-unknown");
    await NodeFSP.mkdir(malformed);
    await NodeFSP.writeFile(NodePath.join(malformed, "runner.json"), "{");
    const linked = NodePath.join(base, "mesh-fast-linked");
    await NodeFSP.symlink(foreign, linked);
    const passed = await fixture(base, dead(), false);
    const abandoned = await fixture(base, dead(), true);
    await NodeFSP.rm(NodePath.join(abandoned, "summary.json"));
    await NodeFSP.utimes(NodePath.join(abandoned, "runner.json"), 1, 1);
    const failures = [];
    for (let index = 0; index < 5; index++) {
      const owner = dead();
      const directory = await fixture(base, owner, true);
      expect(await finishRun(directory, owner, true)).toBe(directory);
      expect(
        JSON.parse(await NodeFSP.readFile(NodePath.join(directory, "retention.json"), "utf8")),
      ).toMatchObject({
        directory,
        failed: true,
      });
      const stamp = index + 2;
      await NodeFSP.utimes(NodePath.join(directory, ".mesh-fast-complete.json"), stamp, stamp);
      failures.push(directory);
    }
    for (const directory of [passed, abandoned, ...failures.slice(0, 2)])
      await expect(NodeFSP.lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    for (const directory of [active, foreign, foreignUid, malformed, linked, ...failures.slice(2)])
      await expect(NodeFSP.lstat(directory)).resolves.toBeDefined();
    expect(
      await NodeFSP.readFile(NodePath.join(failures[4]!, "unmarked-payload.bin"), "utf8"),
    ).toBe("fixture bytes");
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
});

it("protects an orphaned fixture while a real child still uses its directory", async () => {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-retention-"));
  const current = await ownership();
  const directory = await fixture(
    base,
    { ...current, start: "0", runId: NodeCrypto.randomUUID() },
    false,
  );
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["-e", 'console.log("ready"); process.stdin.resume()'],
    {
      cwd: directory,
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const ready = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", () => resolve());
  });
  try {
    await ready;
    expect(await pruneRuns(base, current)).toEqual([]);
    await expect(NodeFSP.lstat(directory)).resolves.toBeDefined();
  } finally {
    child.stdin.end();
    expect(await closed).toBe(0);
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
});

it("fails closed when the compact report directory is an external symlink", async () => {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mesh-retention-"));
  const owner = await ownership();
  try {
    const outside = NodePath.join(base, "outside");
    await NodeFSP.mkdir(outside);
    await NodeFSP.writeFile(NodePath.join(outside, "summary.json"), "owner data");
    await NodeFSP.symlink(outside, NodePath.join(base, "latest"));
    const directory = await fixture(base, owner, false);
    await expect(finishRun(directory, owner, false)).rejects.toThrow(
      "Unowned mesh report directory",
    );
    expect(await NodeFSP.readFile(NodePath.join(outside, "summary.json"), "utf8")).toBe(
      "owner data",
    );
    await expect(NodeFSP.lstat(directory)).resolves.toBeDefined();
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
});
