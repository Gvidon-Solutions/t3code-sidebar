import * as NodeFS from "node:fs";
import { expect, it } from "vitest";

const workflow = (name: string) =>
  NodeFS.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");

it("keeps Android signing behind the release branch and protected environment", () => {
  const source = workflow("sidebar-desktop.yml");
  expect(source).toContain("branches: [ws]");
  expect(source).not.toMatch(/delivery-ci|ci\/a1-timing/);
  const job = source.split("\n  android:\n")[1]!.split("\n  publish-")[0]!;
  expect(job).toContain(
    "if: github.ref == 'refs/heads/ws' && needs.version.outputs.android == 'true'",
  );
  expect(job).toContain("environment: android-release");
});

it("pins mesh actions and removes upstream-only secret workflows", () => {
  for (const match of workflow("mesh-platform-smoke.yml").matchAll(/uses:\s*([^\s]+)/g))
    expect(match[1]).toMatch(/@[a-f0-9]{40}$/);
  expect(
    NodeFS.existsSync(new URL("../.github/workflows/mobile-eas-preview-fork.yml", import.meta.url)),
  ).toBe(false);
  for (const file of NodeFS.readdirSync(new URL("../.github/workflows/", import.meta.url)))
    if (file.endsWith(".yml"))
      expect(workflow(file)).not.toContain("github.repository == 'pingdotgg/t3code'");
});
