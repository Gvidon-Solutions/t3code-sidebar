import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { SidebarWorkspacesConfig } from "@t3tools/contracts";
import { resolveRunPlan } from "./RunPlan.ts";

const decodeConfig = Schema.decodeSync(SidebarWorkspacesConfig);

const config = () =>
  decodeConfig({
    projectTitles: { app: "Sample" },
    projectMounts: {
      app: [
        {
          environmentId: "laptop",
          path: "/copies/app",
          role: "replica",
          transport: "mutagen",
          source: "cloud",
          createdAt: "",
        },
        {
          environmentId: "cloud",
          path: "/work/app",
          role: "primary",
          transport: "git",
          createdAt: "",
        },
      ],
    },
  });
const input = () => ({
  config: config(),
  environmentId: "laptop",
  cwd: "/copies/app/src",
  bindings: { cloudbox: "cloud" },
});

it("maps the same relative directory using the configured primary machine name", () => {
  expect(resolveRunPlan(input())).toMatchObject({
    kind: "remote",
    cwd: "/work/app/src",
    host: "t3-cloudbox",
    replicaRoot: "/copies/app",
    primaryRoot: "/work/app",
  });
});
it("leaves outside folders, primaries and full replicas local", () => {
  for (const cwd of ["/copies/application", "/elsewhere"])
    expect(resolveRunPlan({ ...input(), cwd })).toEqual({ kind: "local" });
  expect(resolveRunPlan({ ...input(), environmentId: "cloud", cwd: "/work/app" })).toEqual({
    kind: "local",
  });
  const data = input();
  data.config = {
    ...data.config,
    projectMounts: {
      ...data.config.projectMounts,
      app: [
        { ...data.config.projectMounts.app![0]!, mode: "full" },
        data.config.projectMounts.app![1]!,
      ],
    },
  };
  expect(resolveRunPlan(data)).toEqual({ kind: "local" });
});
it("refuses missing primaries, unbound machine names and disabled SSH", () => {
  expect(() => resolveRunPlan({ ...input(), bindings: {} })).toThrow(/name/);
  expect(() => resolveRunPlan({ ...input(), sshMode: "off" })).toThrow(/disabled/);
  const data = input();
  data.config = { ...data.config, projectMounts: { app: [data.config.projectMounts.app![0]!] } };
  expect(() => resolveRunPlan(data)).toThrow(/primary/);
});
it("uses the closest representation instead of escaping a nested primary", () => {
  const data = input();
  data.config = {
    ...data.config,
    projectMounts: {
      ...data.config.projectMounts,
      nested: [
        {
          environmentId: "laptop",
          path: "/copies/app/src",
          role: "primary",
          transport: "git",
          createdAt: "",
        },
      ],
    },
  };
  expect(resolveRunPlan(data)).toEqual({ kind: "local" });
});

it("maps Windows replicas to POSIX primaries without depending on the local OS", () => {
  const data = input();
  data.config = {
    ...data.config,
    projectMounts: {
      app: [
        { ...data.config.projectMounts.app![0]!, path: "C:\\copies\\app" },
        data.config.projectMounts.app![1]!,
      ],
    },
  };
  expect(resolveRunPlan({ ...data, cwd: "C:\\copies\\app\\src\\nested" })).toMatchObject({
    cwd: "/work/app/src/nested",
  });
  expect(resolveRunPlan({ ...data, cwd: "D:\\copies\\app" })).toEqual({ kind: "local" });
});

it("uses the user's configured host in existing SSH mode and refuses an absent host", () => {
  const data = {
    ...input(),
    sshMode: "existing" as const,
    machines: { cloudbox: { ssh: { host: "studio-custom" } } },
  };
  expect(resolveRunPlan(data)).toMatchObject({ host: "studio-custom" });
  expect(() => resolveRunPlan({ ...data, machines: {} })).toThrow(/configured SSH host/);
});

it("uses the existing config's actual ignores when reporting ignored outputs", () => {
  const plan = resolveRunPlan({
    ...input(),
    desiredConfig: { schema: 1, machines: {}, replicas: { ignore: ["/private"] } },
  });
  expect(plan.kind).toBe("remote");
  if (plan.kind !== "remote") throw new Error("Expected a remote plan");
  expect(plan.ignores).toContain("/private");
  expect(plan.ignores).not.toContain("*.pdf");
});
