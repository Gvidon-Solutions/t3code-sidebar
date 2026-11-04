import { expect, it } from "@effect/vitest";
import { parseRunArgs } from "./RunCli.ts";
it("preserves command argv and parses execution and background management options", () => {
  expect(
    parseRunArgs([
      "--bg",
      "--ports",
      "3000,8080,3000",
      "--timeout",
      "1.5m",
      "--",
      "node",
      "-e",
      "a b",
    ]),
  ).toMatchObject({
    bg: true,
    ports: [3000, 8080],
    timeoutMs: 90000,
    command: ["node", "-e", "a b"],
  });
  expect(parseRunArgs(["git", "status", "--porcelain"]).command).toEqual([
    "git",
    "status",
    "--porcelain",
  ]);
  expect(parseRunArgs(["--logs", "a".repeat(36), "--follow"])).toMatchObject({
    logs: "a".repeat(36),
    follow: true,
  });
  for (const args of [
    [],
    ["--ports", "0", "--", "echo"],
    ["--ports", "65536", "--", "echo"],
    ["--timeout", "-1s", "echo"],
    ["--timeout", "25h", "echo"],
    ["--list", "echo"],
    ["--follow", "echo"],
    ["--logs", "../bad"],
    ["--unknown", "echo"],
  ])
    expect(() => parseRunArgs(args)).toThrow();
});
