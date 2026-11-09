import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";

import {
  planDraftLogicalProjectKeyRekeys,
  resolveDraftLogicalProjectKey,
  type DraftProjectKeySource,
} from "./draftProjectKey";

const groupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

const project = {
  environmentId: "studio",
  id: "atlas-id",
  title: "Atlas",
  workspaceRoot: "/srv/atlas",
  repositoryIdentity: null,
  isScratch: false,
} as unknown as DraftProjectKeySource;

const config = {
  ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  machines: {},
  projectMounts: {
    "mesh-atlas": [
      {
        environmentId: "studio",
        path: "/srv/atlas",
        projectId: "atlas-id",
        transport: "git",
        role: "primary",
        createdAt: "",
      },
    ],
  },
  projectAliases: {},
} as SidebarWorkspacesConfig;

describe("resolveDraftLogicalProjectKey", () => {
  it("uses the mesh logical key when the layout knows the project", () => {
    expect(resolveDraftLogicalProjectKey(project, groupingSettings, config)).toBe("mesh-atlas");
  });

  it("falls back to the grouping key without a snapshot", () => {
    expect(resolveDraftLogicalProjectKey(project, groupingSettings, null)).toBe(
      "studio:/srv/atlas",
    );
  });
});

describe("planDraftLogicalProjectKeyRekeys", () => {
  it("moves a draft made before the snapshot to the mesh key", () => {
    const rekeys = planDraftLogicalProjectKeyRekeys({
      drafts: [
        {
          draftId: "draft-early",
          environmentId: "studio",
          projectId: "atlas-id",
          logicalProjectKey: "studio:/srv/atlas",
        },
      ],
      projects: [project],
      config,
      groupingSettings,
    });
    expect(rekeys).toEqual([{ draftId: "draft-early", logicalProjectKey: "mesh-atlas" }]);
  });

  it("leaves a deliberate key and other projects alone", () => {
    expect(
      planDraftLogicalProjectKeyRekeys({
        drafts: [
          {
            draftId: "draft-chosen",
            environmentId: "studio",
            projectId: "atlas-id",
            logicalProjectKey: "chosen-by-a-merge",
          },
          {
            draftId: "draft-missing-project",
            environmentId: "studio",
            projectId: "gone",
            logicalProjectKey: "studio:/srv/gone",
          },
        ],
        projects: [project],
        config,
        groupingSettings,
      }),
    ).toEqual([]);
  });

  it("does nothing before the mesh snapshot arrives", () => {
    expect(
      planDraftLogicalProjectKeyRekeys({
        drafts: [
          {
            draftId: "draft-early",
            environmentId: "studio",
            projectId: "atlas-id",
            logicalProjectKey: "studio:/srv/atlas",
          },
        ],
        projects: [project],
        config: null,
        groupingSettings,
      }),
    ).toEqual([]);
  });
});
