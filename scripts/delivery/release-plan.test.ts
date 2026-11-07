// @effect-diagnostics nodeBuiltinImport:off - Release planning runs before workspace dependency installation.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { releasePlan, changedPaths } from "./release-plan.ts";

const workflow = Schema.decodeSync(
  fromYaml(
    Schema.Struct({
      on: Schema.Struct({
        push: Schema.Struct({ branches: Schema.Array(Schema.String) }),
        workflow_dispatch: Schema.Struct({
          inputs: Schema.Struct({ dry_run: Schema.Struct({ default: Schema.Boolean }) }),
        }),
      }),
      jobs: Schema.Record(
        Schema.String,
        Schema.Struct({
          needs: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
          if: Schema.optional(Schema.String),
          "runs-on": Schema.String,
        }),
      ),
    }),
  ),
)(
  NodeFS.readFileSync(
    new URL("../../.github/workflows/sidebar-desktop.yml", import.meta.url),
    "utf8",
  ),
);

it("release source filters keep unrelated platform builds out of the hot path", () => {
  NodeAssert.deepEqual(releasePlan(["docs/delivery.md"]), { desktop: false, android: false });
  NodeAssert.deepEqual(releasePlan(["apps/mobile/src/App.tsx"]), { desktop: false, android: true });
  for (const path of ["apps/web/src/App.tsx", "apps/server/src/bin.ts"]) {
    NodeAssert.deepEqual(releasePlan([path]), { desktop: false, android: false });
  }
  NodeAssert.deepEqual(releasePlan(["apps/desktop/src/boot.ts"]), {
    desktop: true,
    android: false,
  });
  for (const path of ["pnpm-lock.yaml", "packages/client-runtime/src/index.ts"]) {
    NodeAssert.deepEqual(releasePlan([path]), { desktop: true, android: true });
  }
  NodeAssert.deepEqual(changedPaths("000000000000", "HEAD"), ["pnpm-lock.yaml"]);
});

it("Windows never waits for the Linux installer; artifact publication has no cross-platform barrier", () => {
  NodeAssert.deepEqual(workflow.jobs.windows!.needs, ["version", "bundle", "runtime"]);
  NodeAssert.deepEqual(workflow.jobs.runtime!.needs, ["version", "bundle"]);
  NodeAssert.deepEqual(workflow.jobs.release!.needs, ["version", "runtime"]);
  for (const platform of ["linux", "windows", "android"]) {
    NodeAssert.deepEqual(workflow.jobs[`publish-${platform}`]!.needs, [
      "version",
      "release",
      platform,
    ]);
    NodeAssert.match(
      workflow.jobs[platform]!.if!,
      /needs.version.outputs.(desktop|android) == 'true'/,
    );
  }
  for (const job of Object.values(workflow.jobs))
    NodeAssert.doesNotMatch(job["runs-on"], /self-hosted/);
});

it("release creation is fenced to the release branch and dry-run is the manual default", () => {
  NodeAssert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
  NodeAssert.match(workflow.jobs.release!.if!, /!inputs.dry_run/);
  const branches = [...workflow.jobs.release!.if!.matchAll(/github.ref == '([^']+)'/g)].map(
    (match) => match[1],
  );
  NodeAssert.deepEqual(branches, ["refs/heads/ws", "refs/heads/ws"]);
  NodeAssert.ok(workflow.on.push.branches.includes("delivery-ci/**"));
});

it("path planner diffs renamed paths without splitting spaces and refuses invalid refs", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "delivery-plan-"));

  try {
    NodeChildProcess.execFileSync("git", ["init", "--quiet", root]);
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync(
        "git",
        [
          "-C",
          root,
          "-c",
          "user.name=Delivery Test",
          "-c",
          "user.email=delivery@example.invalid",
          ...args,
        ],
        { encoding: "utf8" },
      ).trim();
    NodeFS.writeFileSync(NodePath.join(root, "before.txt"), "before");
    git("add", ".");
    git("commit", "--quiet", "-m", "initial");
    const base = git("rev-parse", "HEAD");
    NodeFS.writeFileSync(NodePath.join(root, "file with spaces.txt"), "after");
    git("add", ".");
    git("commit", "--quiet", "-m", "change");
    NodeAssert.deepEqual(changedPaths(base, "HEAD", root), ["file with spaces.txt"]);
    NodeAssert.throws(() => changedPaths("missing-ref", "HEAD", root));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
