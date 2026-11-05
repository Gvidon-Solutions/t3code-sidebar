import { expect, it } from "@effect/vitest";
import { replicaIgnorePatterns } from "./replicaModel.ts";
it("anchors generated outputs at the root while excluding nested node_modules", () => {
  const patterns = replicaIgnorePatterns(["*.log", "/data"]);
  expect(patterns).toEqual(
    expect.arrayContaining([
      "/node_modules",
      "/.venv",
      "/dist",
      "/build",
      "/target",
      "/.t3",
      "/.t3-conflicts",
      "node_modules",
      "*.log",
      "/data",
    ]),
  );
  expect(patterns).not.toContain("build");
  expect(patterns).not.toContain("dist");
  expect(patterns).not.toContain("target");
});
