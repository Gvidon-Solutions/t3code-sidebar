import { describe, expect, it } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Execute the exact portable shell command against real files.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- This fixture checks shell filesystem behavior.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous fixture paths for the shell command.
import * as NodePath from "node:path";
import { conflictCopyPath, conflictRoots, preserveConflictCommand } from "./conflictResolution.ts";
const iso = "2026-11-03T10:20:30.000Z";
describe("conflict copies", () => {
  it("keeps paths, rejects traversal and never archives its own copies", () => {
    expect(conflictCopyPath(iso, "src/file")).toBe(`.t3-conflicts/${iso}/src/file`);
    for (const path of ["", "/etc/passwd", "../a", "a/../../b", "a\\b", ".t3-conflicts/a", "a//b"])
      expect(() => conflictCopyPath(iso, path)).toThrow();
    expect(conflictRoots(["a/b", "a", "a", "abc"])).toEqual(["a", "abc"]);
  });
  it("preserves files, directories, quoted names and deletions and refuses to overwrite a copy", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "N-conflict-"));
    try {
      NodeFS.mkdirSync(NodePath.join(root, "src"));
      NodeFS.writeFileSync(NodePath.join(root, "src/a'file"), "loser");
      NodeChildProcess.execFileSync("sh", [
        "-c",
        preserveConflictCommand(root, iso, ["src", "deleted"]),
      ]);
      expect(
        NodeFS.readFileSync(NodePath.join(root, conflictCopyPath(iso, "src/a'file")), "utf8"),
      ).toBe("loser");
      expect(NodeFS.existsSync(NodePath.join(root, "src"))).toBe(false);
      NodeFS.mkdirSync(NodePath.join(root, "src"));
      expect(() =>
        NodeChildProcess.execFileSync("sh", ["-c", preserveConflictCommand(root, iso, ["src"])]),
      ).toThrow();
      expect(NodeFS.existsSync(NodePath.join(root, "src"))).toBe(true);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
