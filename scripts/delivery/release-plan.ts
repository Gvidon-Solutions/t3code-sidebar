// @effect-diagnostics nodeBuiltinImport:off - Release planning runs before workspace dependency installation.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

export function releasePlan(paths: readonly string[]) {
  const infrastructure =
    /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|patches\/|\.github\/workflows\/sidebar-desktop\.yml|scripts\/delivery\/release-plan\.ts)/;
  const shared = /^packages\//;
  return {
    desktop: paths.some(
      (path) =>
        infrastructure.test(path) ||
        shared.test(path) ||
        /^(apps\/(desktop|web|server)\/|native\/|scripts\/(build-desktop|build-cli|lib\/|update-release))/.test(
          path,
        ),
    ),
    android: paths.some(
      (path) => infrastructure.test(path) || shared.test(path) || /^apps\/mobile\//.test(path),
    ),
  };
}

export function changedPaths(base: string | undefined, head: string, cwd = process.cwd()) {
  if (!base || /^0+$/.test(base)) return ["pnpm-lock.yaml"];
  return NodeChildProcess.execFileSync("git", ["diff", "--name-only", "-z", base, head], {
    encoding: "utf8",
    cwd,
  })
    .split("\0")
    .filter(Boolean);
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const plan = releasePlan(changedPaths(process.env.BASE_SHA, process.env.GITHUB_SHA || "HEAD"));
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  NodeFS.appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(plan)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
