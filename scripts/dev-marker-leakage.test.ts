// @effect-diagnostics nodeBuiltinImport:off -- Scans the tracked documentation boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

// Real identifiers that happen to look like stage codes: the product name, keyboard keys,
// cloud storage and an example provider thread.
const allowed = new Set(["T3", "F1", "F2", "F6", "F8", "R2", "R8", "C1"]);
const stageCode = /\b[CFUJTRNBDX]\d[ab]?\b/g;
const devMarker = /\b(?:stage|round)\s+[A-Z]?\d+\b/i;

it("keeps development stage markers out of repository documents", () => {
  const root = NodePath.resolve(import.meta.dirname, "..");
  const files = NodeChildProcess.execFileSync(
    "git",
    ["ls-files", "-z", "--", "docs", "FORK.md", "README.md"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter((file) => file.endsWith(".md"));
  const leaked: string[] = [];
  for (const file of files) {
    const lines = NodeFS.readFileSync(NodePath.join(root, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (devMarker.test(line)) leaked.push(`${file}:${index + 1}: ${line.trim()}`);
      for (const match of line.matchAll(stageCode))
        if (!allowed.has(match[0])) leaked.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  expect(leaked).toEqual([]);
});
