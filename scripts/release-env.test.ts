// @effect-diagnostics nodeBuiltinImport:off -- Runs the release entry point as a subprocess to prove it refuses test flags.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  assertReleaseBuildEnv,
  isReleaseBuildEnv,
  releaseBuildTestFlags,
} from "./lib/release-env.ts";

const root = NodePath.resolve(import.meta.dirname, "..");

it("reports and refuses every enabled test-build flag", () => {
  expect(releaseBuildTestFlags({ PATH: "/bin" })).toEqual([]);
  expect(
    releaseBuildTestFlags({
      T3CODE_MESH_TEST_BUILD: "1",
      T3CODE_OTHER_TEST_BUILD: "true",
      T3CODE_TEST_BUILD_DISABLED: "0",
      T3CODE_MESH_TEST_VOICE_PROVIDER: "1",
    }),
  ).toEqual(["T3CODE_MESH_TEST_BUILD", "T3CODE_OTHER_TEST_BUILD"]);
  expect(() => assertReleaseBuildEnv({})).not.toThrow();
  expect(() => assertReleaseBuildEnv({ T3CODE_MESH_TEST_BUILD: "1" })).toThrow(
    "Refusing a release build with test-only flags set: T3CODE_MESH_TEST_BUILD",
  );
});

it("the release archive pipeline exits nonzero when a test-build flag is inherited", () => {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(root, "scripts/build-cli-archive.ts")],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, T3CODE_MESH_TEST_BUILD: "1" },
      timeout: 60_000,
    },
  );
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain(
    "Refusing a release build with test-only flags set: T3CODE_MESH_TEST_BUILD",
  );
});

it("recognises release builds without treating dev builds as releases", () => {
  expect(isReleaseBuildEnv({})).toBe(false);
  expect(isReleaseBuildEnv({ CI: "true" })).toBe(true);
  expect(isReleaseBuildEnv({ VITE_RELEASE_CHANNEL: "stable" })).toBe(true);
  expect(isReleaseBuildEnv({ VITE_RELEASE_CHANNEL: "dev" })).toBe(false);
  expect(isReleaseBuildEnv({ APP_VERSION: "0.1.7-sidebar.1" })).toBe(true);
  expect(isReleaseBuildEnv({ CI: "true", T3CODE_BUILT_DEV: "1" })).toBe(false);
  expect(() => {
    const env = { CI: "true", T3CODE_MESH_TEST_BUILD: "1" };
    if (isReleaseBuildEnv(env)) assertReleaseBuildEnv(env);
  }).toThrow("Refusing a release build");
});

it("the delivery builder refuses test-build flags before reading its config", () => {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(root, "scripts/delivery/builder.mjs"), "run", "/nonexistent/config.json"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, T3CODE_MESH_TEST_BUILD: "1" },
      timeout: 60_000,
    },
  );
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain(
    "Refusing a release build with test-only flags set: T3CODE_MESH_TEST_BUILD",
  );
});

const verifyVersion = (version: string, directory: string) =>
  NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(root, "scripts/verify-app-version.mjs"), version, directory],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );

it("the version check requires an exact version match, not a prefix", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-app-version-"));
  try {
    NodeFS.writeFileSync(NodePath.join(directory, "app.js"), 'const version = "0.1.7-sidebar.63";');
    const prefix = verifyVersion("0.1.7-sidebar.6", directory);
    expect(prefix.status).not.toBe(0);
    expect(prefix.stderr).toContain("does not contain version 0.1.7-sidebar.6");
    expect(verifyVersion("0.1.7-sidebar.63", directory).status).toBe(0);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
