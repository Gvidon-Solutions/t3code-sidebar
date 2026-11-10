import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { openLocatedFile } from "./openLocatedFile";

const threadRef = {
  environmentId: EnvironmentId.make("studio"),
  threadId: ThreadId.make("thread-1"),
};

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
});

describe("openLocatedFile", () => {
  it("N1 · keeps a picked candidate's root and notes on another machine", () => {
    openLocatedFile(threadRef, {
      environmentId: EnvironmentId.make("cloudbox"),
      absolutePath: "/srv/cloudbox/proj/apps/web/src/x.ts",
      line: 4,
      root: "/srv/cloudbox/proj",
      rawPath: "src/x.ts",
      displayPath: "apps/web/src/x.ts",
      projectTitle: "Proj",
      inProject: true,
      notSynced: true,
      worktreeRemoved: true,
    });
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
    expect(state.surfaces).toMatchObject([
      {
        environmentId: "cloudbox",
        workspaceRoot: "/srv/cloudbox/proj",
        projectName: "Proj",
        root: "/srv/cloudbox/proj",
        rawPath: "src/x.ts",
        resolvedDisplayPath: "apps/web/src/x.ts",
        notSynced: true,
        worktreeRemoved: true,
        revealLine: 4,
      },
    ]);
  });

  it("N1 · keeps Outside project for a same-machine pick", () => {
    openLocatedFile(threadRef, {
      environmentId: threadRef.environmentId,
      absolutePath: "/tmp/notes.md",
      root: "/tmp",
      rawPath: "/tmp/notes.md",
      displayPath: "notes.md",
      inProject: false,
    });
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
    expect(state.surfaces).toMatchObject([
      { inProject: false, root: "/tmp", relativePath: "/tmp/notes.md" },
    ]);
  });
});
