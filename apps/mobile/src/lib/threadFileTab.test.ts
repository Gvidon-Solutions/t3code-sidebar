import { describe, expect, it } from "vite-plus/test";

import { threadFileTab } from "./threadFileTab";

const resolved = {
  environmentId: "cloudbox",
  threadId: "thread",
  path: "/data/cloudbox/proj/apps/web/src/lib/x.ts",
  fileTarget: "resolved",
  fileEnvironmentId: "cloudbox",
  cwd: "/data/cloudbox/proj",
  sourceEnvironmentId: "cloudbox",
  projectName: "Proj",
  rawPath: "src/lib/x.ts",
  displayPath: "apps/web/src/lib/x.ts",
} as const;

describe("threadFileTab", () => {
  it("keeps the resolved target for a package-relative path", () => {
    expect(threadFileTab(resolved)).toEqual({
      path: resolved.path,
      line: null,
      tabFile: {
        environmentId: "cloudbox",
        absolutePath: resolved.path,
        cwd: resolved.cwd,
        sourceEnvironmentId: "cloudbox",
        projectName: "Proj",
        rawPath: "src/lib/x.ts",
        displayPath: "apps/web/src/lib/x.ts",
      },
    });
  });

  it("keeps another machine and the not-synced note on the tab", () => {
    expect(
      threadFileTab({
        ...resolved,
        fileEnvironmentId: "studio",
        sourceEnvironmentId: "cloudbox",
        cwd: "/data/studio/proj",
        notSynced: "1",
      })?.tabFile,
    ).toMatchObject({ environmentId: "studio", sourceEnvironmentId: "cloudbox", notSynced: true });
  });

  it("keeps an outside-project tab", () => {
    expect(threadFileTab({ ...resolved, outsideProject: "1" })?.tabFile).toMatchObject({
      outsideProject: true,
    });
  });

  it("keeps a removed-worktree tab", () => {
    expect(threadFileTab({ ...resolved, worktreeRemoved: "1" })?.tabFile).toMatchObject({
      worktreeRemoved: true,
    });
  });

  it("keeps the file machine for a t3-file link and a picker choice", () => {
    expect(
      threadFileTab({
        ...resolved,
        fileEnvironmentId: "studio",
        cwd: "/data/studio/proj",
      })?.tabFile,
    ).toMatchObject({ environmentId: "studio", absolutePath: resolved.path });
    expect(
      threadFileTab({ ...resolved, displayPath: "apps/admin/src/lib/x.ts" })?.tabFile,
    ).toMatchObject({ displayPath: "apps/admin/src/lib/x.ts" });
  });

  it("leaves a legacy path open without a resolver target", () => {
    expect(
      threadFileTab({
        environmentId: "cloudbox",
        threadId: "thread",
        path: "apps/web/src/lib/x.ts",
      }),
    ).toEqual({ path: "apps/web/src/lib/x.ts", line: null });
  });
});
