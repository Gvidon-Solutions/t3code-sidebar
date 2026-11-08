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

describe("hidesGitControls", () => {
  it("hides git until the layout loads instead of guessing it is a primary", () => {
    expect(hidesGitControls(null, "studio", "p1")).toBe(true);
  });
  it("hides git on a replica and keeps it on the primary", () => {
    expect(hidesGitControls(config, "cloudbox", "p1")).toBe(true);
    expect(hidesGitControls(config, "studio", "p1")).toBe(false);
  });
});
