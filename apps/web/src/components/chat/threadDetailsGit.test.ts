import { describe, expect, it } from "vite-plus/test";
import { threadDetailsGitVisibility } from "./threadDetailsGit";

const visible = { branch: true, gitActions: true, changes: true };

describe("threadDetailsGitVisibility", () => {
  it("shows Version Control for a primary checkout", () => {
    expect(
      threadDetailsGitVisibility({
        isReplica: false,
        gitCwd: "/work/atlas",
        isGitRepo: true,
        activeProjectName: "Atlas",
        visible,
      }),
    ).toEqual({ branch: true, git: true, section: true });
  });

  it("hides git affordances on a lite replica so it never offers Initialize Git", () => {
    expect(
      threadDetailsGitVisibility({
        isReplica: true,
        gitCwd: "/work/atlas",
        isGitRepo: false,
        activeProjectName: "Atlas",
        visible,
      }),
    ).toEqual({ branch: false, git: false, section: false });
  });

  it("still shows git actions on a plain folder when the user enabled them", () => {
    expect(
      threadDetailsGitVisibility({
        isReplica: false,
        gitCwd: "/work/notes",
        isGitRepo: false,
        activeProjectName: "Notes",
        visible,
      }),
    ).toEqual({ branch: false, git: true, section: true });
  });
});
