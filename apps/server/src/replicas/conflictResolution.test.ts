import { preserveConflictScript } from "./ReplicaPlatform.ts";
import { conflictMtimeScript } from "./conflictMtimeScript.ts";
import { describe, expect, it } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Execute the exact portable shell command against real files.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- This fixture checks shell filesystem behavior.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous fixture paths for the shell command.
import * as NodePath from "node:path";
import { conflictCopyPath, conflictRoots } from "./conflictResolution.ts";
const iso = "2026-11-03T10:20:30.000Z";
describe("conflict copies", () => {
  it("keeps paths, rejects traversal and never archives its own copies", () => {
    expect(conflictCopyPath(iso, "src/file")).toBe(
      ".t3-conflicts/2026-11-03T10-20-30-000Z/src/file",
    );
    for (const path of ["", "/etc/passwd", "../a", "a/../../b", "a\\b", ".t3-conflicts/a", "a//b"])
      expect(() => conflictCopyPath(iso, path)).toThrow();
    expect(conflictRoots(["a/b", "a", "a", "abc"])).toEqual(["a", "abc"]);
  });
  it("preserves files, directories, quoted names and deletions and refuses to overwrite a copy", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "N-conflict-"));
    try {
      NodeFS.mkdirSync(NodePath.join(root, "src"));
      NodeFS.writeFileSync(NodePath.join(root, "src/a'file"), "loser");
      NodeChildProcess.execFileSync(process.execPath, [
        "-e",
        preserveConflictScript(root, iso, ["src", "deleted"]),
      ]);
      expect(
        NodeFS.readFileSync(NodePath.join(root, conflictCopyPath(iso, "src/a'file")), "utf8"),
      ).toBe("loser");
      expect(NodeFS.existsSync(NodePath.join(root, "src"))).toBe(false);
      NodeFS.mkdirSync(NodePath.join(root, "src"));
      expect(() =>
        NodeChildProcess.execFileSync(process.execPath, [
          "-e",
          preserveConflictScript(root, iso, ["src"]),
        ]),
      ).toThrow();
      expect(NodeFS.existsSync(NodePath.join(root, "src"))).toBe(true);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});

it("reads portable per-path modification times and refuses traversal or symlink parents", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "C1-mtime-"));
  try {
    NodeFS.writeFileSync(NodePath.join(root, "first"), "a");
    NodeFS.writeFileSync(NodePath.join(root, "second"), "b");
    NodeFS.utimesSync(NodePath.join(root, "first"), 100, 100);
    NodeFS.utimesSync(NodePath.join(root, "second"), 200, 200);
    const run = (paths: string[]) =>
      Number(
        NodeChildProcess.execFileSync(process.execPath, ["-e", conflictMtimeScript(root, paths)], {
          encoding: "utf8",
        }),
      );
    expect(run(["first"])).toBe(100000);
    expect(run(["second"])).toBe(200000);
    expect(run(["deleted"])).toBe(0);
    expect(run(["removed/nested"])).toBe(0);
    expect(() => conflictMtimeScript(root, ["../outside"])).toThrow("Unsafe conflict path");
    NodeFS.symlinkSync(NodeOS.tmpdir(), NodePath.join(root, "escape"), "dir");
    expect(() => run(["escape/file"])).toThrow();
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
