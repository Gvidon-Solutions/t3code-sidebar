// @effect-diagnostics nodeBuiltinImport:off -- Runs the release entry point as a subprocess to prove it refuses test flags.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { assertReleaseBuildEnv, releaseBuildTestFlags } from "./lib/release-env.ts";

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
