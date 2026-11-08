import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG as empty } from "@t3tools/contracts";
import { threadHeaderSubtitle } from "./threadHeaderSubtitle";

describe("threadHeaderSubtitle", () => {
  it("shows the machine tag once the mesh has more than one machine", () => {
    expect(
      threadHeaderSubtitle({
        config: {
          ...empty,
          machines: { studio: { title: "Studio", tag: "ST" }, cloudbox: { title: "Cloudbox" } },
        },
        environmentId: "studio",
        environmentLabel: "Studio",
        projectTitle: "Atlas",
        delegatedParent: null,
      }),
    ).toBe("Atlas · ST");
  });

  it("keeps the plain environment label on a single-machine install", () => {
    expect(
      threadHeaderSubtitle({
        config: { ...empty, machines: { studio: { title: "Studio", tag: "ST" } } },
        environmentId: "studio",
        environmentLabel: "Studio",
        projectTitle: "Atlas",
        delegatedParent: "Subagent of Parent",
      }),
    ).toBe("Atlas · Studio · Subagent of Parent");
  });

  it("omits unknown parts instead of printing separators", () => {
    expect(
      threadHeaderSubtitle({
        config: null,
        environmentId: null,
        environmentLabel: null,
        projectTitle: null,
        delegatedParent: null,
      }),
    ).toBe("");
  });
});
