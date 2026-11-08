import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG as empty } from "@t3tools/contracts";
import { hidesGitControls } from "./gitVisibility.ts";

const config = {
  ...empty,
  machines: { studio: { title: "Studio" }, cloudbox: { title: "Cloudbox" } },
  projectMounts: {
    demo: [
      {
        environmentId: "studio",
        role: "primary" as const,
        projectId: "p1",
        path: "/demo",
        transport: "git" as const,
        createdAt: "",
      },
      {
        environmentId: "cloudbox",
        role: "replica" as const,
        projectId: "p1",
        path: "/demo",
        transport: "mutagen" as const,
        source: "studio",
        createdAt: "",
      },
    ],
  },
};

const base = { environmentId: "studio", projectId: "p1" };

describe("hidesGitControls", () => {
  it("shows git without a mesh: a folder is an ordinary project", () => {
    expect(hidesGitControls({ ...base, config: null, layoutLoading: false })).toBe(false);
  });
  it("hides git only while a mesh layout is genuinely loading", () => {
    expect(hidesGitControls({ ...base, config: null, layoutLoading: true })).toBe(true);
    expect(hidesGitControls({ ...base, config, layoutLoading: true })).toBe(false);
  });
  it("hides git on a replica and keeps it on the primary", () => {
    expect(
      hidesGitControls({
        environmentId: "cloudbox",
        projectId: "p1",
        config,
        layoutLoading: false,
      }),
    ).toBe(true);
    expect(hidesGitControls({ ...base, config, layoutLoading: false })).toBe(false);
  });
});
