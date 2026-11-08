import { expect, it } from "vite-plus/test";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { threadProjectTarget } from "./threadTarget.ts";

it("uses the thread's own representation of a remote project, including aliases and pending copies", () => {
  const rep = {
    environmentId: "a",
    path: "/local",
    projectId: "local",
    role: "replica" as const,
    transport: "mutagen" as const,
    createdAt: "",
  };
  const config = {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    projectAliases: { legacy: "opaque" },
    projectMounts: { opaque: [rep, { ...rep, environmentId: "b", projectId: "remote" }] },
  };
  expect(threadProjectTarget(config, "a", { environmentId: "b", projectId: "remote" })).toEqual({
    logicalKey: "opaque",
    local: rep,
  });
  expect(threadProjectTarget(config, "a", { environmentId: "b", logicalKey: "legacy" }).local).toBe(
    rep,
  );
  expect(
    threadProjectTarget(config, "c", { environmentId: "b", projectId: "remote" }).local,
  ).toBeUndefined();
  const { projectId: _projectId, ...pending } = rep;
  expect(
    threadProjectTarget({ ...config, projectMounts: { opaque: [pending] } }, "a", {
      environmentId: "b",
      logicalKey: "opaque",
    }).local?.path,
  ).toBe("/local");
});
it("uses the same cycle representative from every entry path", () => {
  const config = {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    projectAliases: { a: "z", z: "y", y: "z" },
  };
  for (const logicalKey of ["a", "y", "z"]) {
    expect(
      threadProjectTarget(config, "studio", { environmentId: "cloudbox", logicalKey }).logicalKey,
    ).toBe("y");
  }
});
