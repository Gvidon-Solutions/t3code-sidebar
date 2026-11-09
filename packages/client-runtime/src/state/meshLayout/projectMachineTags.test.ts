import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectMachineTags } from "./logicalProjects.ts";

const config: SidebarWorkspacesConfig = {
  ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  machines: {
    studio: { title: "studio", tag: "ST" },
    laptop: { title: "laptop", tag: "LT" },
    cloudbox: { title: "cloudbox", tag: "CB" },
  },
  projectMounts: {
    "logical-atlas": [
      {
        environmentId: "laptop",
        path: "/home/user/Atlas",
        projectId: "project-laptop",
        transport: "manual",
        role: "replica",
        source: "studio",
        createdAt: "",
      },
      {
        environmentId: "studio",
        path: "/work/Atlas",
        projectId: "project-studio",
        transport: "git",
        role: "primary",
        createdAt: "",
      },
    ],
  },
};

describe("projectMachineTags", () => {
  it("lists one logical project's machines main copy first, from config titles", () => {
    expect(projectMachineTags(config, "logical-atlas")).toEqual([
      {
        environmentId: "studio",
        label: "studio",
        tag: "ST",
        color: expect.any(String),
        primary: true,
      },
      {
        environmentId: "laptop",
        label: "laptop",
        tag: "LT",
        color: expect.any(String),
        primary: false,
      },
    ]);
  });

  it("never falls back to an OS hostname for an unconfigured representation", () => {
    expect(projectMachineTags(config, "missing", ["laptop"])).toEqual([
      {
        environmentId: "laptop",
        label: "laptop",
        tag: "LT",
        color: expect.any(String),
        primary: true,
      },
    ]);
  });
});
