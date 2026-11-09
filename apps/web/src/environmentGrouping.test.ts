import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveLogicalProjectKeyFromSettings,
  pickableProjectGroups,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  resolveSidebarProjectScopeKey,
  getSidebarProjectSettingsKey,
} from "./sidebarProjectGrouping";
import type { Project } from "./types";

const primaryEnvironmentId = EnvironmentId.make("env-primary");
const remoteEnvironmentId = EnvironmentId.make("env-remote");
const repositoryIdentity = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/shared-repo.git",
  },
};
const defaultGroupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("project-1"),
    environmentId: primaryEnvironmentId,
    title: "shared-repo",
    workspaceRoot: "/tmp/shared-repo",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

describe("environment grouping", () => {
  it("opens physical scratch settings from the merged filter, including a remote thread target", () => {
    const local = makeProject({
      title: "No project",
      workspaceRoot: "/local/scratch",
      isScratch: true,
    });
    const remote = makeProject({
      title: "No project",
      id: ProjectId.make("remote-scratch"),
      environmentId: remoteEnvironmentId,
      workspaceRoot: "/remote/scratch",
      isScratch: true,
    });
    const input = {
      projects: [local, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    };
    const filters = buildSidebarProjectSnapshots({ ...input, groupScratchProjects: true });
    const settingsGroups = buildSidebarProjectSnapshots(input);
    expect(filters).toHaveLength(1);
    expect(settingsGroups).toHaveLength(2);
    expect(settingsGroups.map((group) => group.memberProjectRefs)).toEqual([
      [{ environmentId: local.environmentId, projectId: local.id }],
      [{ environmentId: remote.environmentId, projectId: remote.id }],
    ]);
    expect(getSidebarProjectSettingsKey(filters[0]!, defaultGroupingSettings, input.projects)).toBe(
      settingsGroups[0]?.projectKey,
    );
    expect(
      getSidebarProjectSettingsKey(filters[0]!, defaultGroupingSettings, input.projects, {
        environmentId: remote.environmentId,
        projectId: remote.id,
      }),
    ).toBe(settingsGroups[1]?.projectKey);
  });

  it.each(["repository", "repository_path"] as const)(
    "migrates a scratch scope selected before config in %s mode",
    (mode) => {
      const project = makeProject({
        workspaceRoot: "/repo/scratch",
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/repo" },
      });
      const settings = { ...defaultGroupingSettings, sidebarProjectGroupingMode: mode };
      const key = deriveLogicalProjectKeyFromSettings(project, settings);
      const groups = buildSidebarProjectSnapshots({
        projects: [{ ...project, isScratch: true }],
        groupScratchProjects: true,
        settings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      });
      expect(
        resolveSidebarProjectScopeKey({ groups, key, settings, canClearMissingScope: true }),
      ).toBe(groups[0]?.projectKey);
    },
  );

  it("prefers an existing ordinary repository scope over a scratch alias", () => {
    const scratch = makeProject({ isScratch: true, repositoryIdentity });
    const ordinary = makeProject({
      id: ProjectId.make("ordinary"),
      workspaceRoot: "/ordinary",
      repositoryIdentity,
    });
    const groups = buildSidebarProjectSnapshots({
      projects: [scratch, ordinary],
      groupScratchProjects: true,
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });
    const key = deriveLogicalProjectKeyFromSettings(ordinary, defaultGroupingSettings);
    expect(resolveSidebarProjectScopeKey({ groups, key, canClearMissingScope: true })).toBe(key);
  });

  it("dedupes stale project rows with the same environment and workspace path", () => {
    const duplicate = makeProject({
      id: ProjectId.make("project-duplicate"),
      workspaceRoot: "/tmp/shared-repo/",
      repositoryIdentity,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const primary = makeProject({
      id: ProjectId.make("project-primary"),
      repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      workspaceRoot: "/tmp/shared-repo",
      repositoryIdentity,
    });

    const snapshots = buildSidebarProjectSnapshots({
      projects: [primary, duplicate, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) =>
        environmentId === remoteEnvironmentId ? "remote" : "primary",
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.groupedProjectCount).toBe(2);
    expect(snapshots[0]?.memberProjects.map((project) => project.id)).toEqual([
      primary.id,
      remote.id,
    ]);
  });

  it("dedupes stale project rows before logical grouping", () => {
    const staleWithoutRepositoryIdentity = makeProject({
      id: ProjectId.make("project-stale"),
      repositoryIdentity: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const canonical = makeProject({
      id: ProjectId.make("project-canonical"),
      repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });

    const snapshots = buildSidebarProjectSnapshots({
      projects: [staleWithoutRepositoryIdentity, canonical, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) =>
        environmentId === remoteEnvironmentId ? "remote" : "primary",
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.projectKey).toBe(repositoryIdentity.canonicalKey);
    expect(snapshots[0]?.memberProjects.map((project) => project.id)).toEqual([
      canonical.id,
      remote.id,
    ]);
    expect(snapshots[0]?.memberProjectRefs).toEqual([
      {
        environmentId: primaryEnvironmentId,
        projectId: staleWithoutRepositoryIdentity.id,
      },
      { environmentId: primaryEnvironmentId, projectId: canonical.id },
      { environmentId: remoteEnvironmentId, projectId: remote.id },
    ]);

    const [pickerEntry] = buildSidebarProjectPickerEntries({
      groups: snapshots,
      preferredProjectRef: {
        environmentId: primaryEnvironmentId,
        projectId: staleWithoutRepositoryIdentity.id,
      },
    });
    expect(pickerEntry?.isPreferred).toBe(true);
    expect(pickerEntry?.targetProject.id).toBe(canonical.id);
  });

  it("keeps the current environment when available and falls back otherwise", () => {
    const currentPrimary = makeProject({ repositoryIdentity });
    const currentRemote = makeProject({
      id: ProjectId.make("current-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });
    const destinationRepositoryIdentity = {
      canonicalKey: "github.com/example/destination",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/destination.git",
      },
    };
    const destinationPrimary = makeProject({
      id: ProjectId.make("destination-primary"),
      title: "destination",
      workspaceRoot: "/tmp/destination",
      repositoryIdentity: destinationRepositoryIdentity,
    });
    const destinationRemote = makeProject({
      id: ProjectId.make("destination-remote"),
      environmentId: remoteEnvironmentId,
      title: "destination",
      workspaceRoot: "/remote/destination",
      repositoryIdentity: destinationRepositoryIdentity,
    });
    const fallbackPrimary = makeProject({
      id: ProjectId.make("fallback-primary"),
      title: "fallback",
      workspaceRoot: "/tmp/fallback",
    });
    const groups = buildSidebarProjectSnapshots({
      projects: [
        currentPrimary,
        currentRemote,
        destinationPrimary,
        destinationRemote,
        fallbackPrimary,
      ],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    const entries = buildSidebarProjectPickerEntries({
      groups,
      preferredProjectRef: {
        environmentId: remoteEnvironmentId,
        projectId: currentRemote.id,
      },
    });
    const destination = entries.find(
      (entry) => entry.group.projectKey === destinationRepositoryIdentity.canonicalKey,
    );
    const fallback = entries.find((entry) => entry.group.displayName === "fallback");

    expect(destination?.targetProject).toMatchObject({
      environmentId: remoteEnvironmentId,
      id: destinationRemote.id,
    });
    expect(fallback?.targetProject).toMatchObject({
      environmentId: primaryEnvironmentId,
      id: fallbackPrimary.id,
    });
  });

  it("puts the preferred project after pinned projects", () => {
    const project = (title: string, pinnedAt: string | null = null) =>
      makeProject({
        id: ProjectId.make(title),
        title,
        workspaceRoot: `/tmp/${title}`,
        repositoryIdentity: null,
        pinnedAt,
      });
    const current = project("current");
    const groups = buildSidebarProjectSnapshots({
      projects: [project("other"), project("pinned", "2026-01-01T00:00:00.000Z"), current],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });
    const entries = buildSidebarProjectPickerEntries({
      groups: pickableProjectGroups(groups),
      preferredProjectRef: { environmentId: current.environmentId, projectId: current.id },
    });
    expect(entries.map((entry) => entry.group.displayName)).toEqual(["pinned", "current", "other"]);
  });
});

describe("T3 Mesh logical projects", () => {
  const local = makeProject({
    id: ProjectId.make("local"),
    title: "shared",
    workspaceRoot: "/tmp/shared-repo",
  });
  const remote = makeProject({
    id: ProjectId.make("remote"),
    environmentId: remoteEnvironmentId,
    title: "shared",
    workspaceRoot: "/remote/shared-repo",
  });
  const layout: SidebarWorkspacesConfig = {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    projectMounts: {
      "logical-shared": [
        {
          environmentId: local.environmentId,
          path: local.workspaceRoot,
          transport: "git",
          role: "primary",
          createdAt: "",
        },
        {
          environmentId: remote.environmentId,
          path: remote.workspaceRoot,
          transport: "mutagen",
          role: "replica",
          source: local.environmentId,
          createdAt: "",
        },
      ],
    },
  };

  it("groups representations by the layout even without repository identity", () => {
    const groups = buildSidebarProjectSnapshots({
      projects: [local, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
      layout,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.projectKey).toBe("logical-shared");
    expect(groups[0]?.memberProjects).toHaveLength(2);
  });

  it("shows one row per logical project when only some machines are connected", () => {
    const cloudbox = EnvironmentId.make("env-cloudbox");
    const laptop = EnvironmentId.make("env-laptop");
    const threeMachineLayout: SidebarWorkspacesConfig = {
      ...layout,
      machines: {
        [remoteEnvironmentId]: { label: "Cloudbox" },
        [cloudbox]: { label: "Cloudbox" },
        [laptop]: { label: "Laptop" },
      },
      projectMounts: {
        ...layout.projectMounts,
        "logical-elsewhere": [
          {
            environmentId: cloudbox,
            path: "/repos/elsewhere",
            transport: "mutagen",
            role: "replica",
            source: remoteEnvironmentId,
            createdAt: "",
          },
          {
            environmentId: laptop,
            path: "/repos/elsewhere",
            transport: "mutagen",
            role: "replica",
            source: remoteEnvironmentId,
            createdAt: "",
          },
        ],
      },
    };
    const groups = buildSidebarProjectSnapshots({
      // The client sees only its own representation of the shared project.
      projects: [local],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => String(environmentId),
      layout: threeMachineLayout,
      connectedEnvironmentIds: new Set([primaryEnvironmentId]),
    });
    const shared = groups.filter(
      (group) => group.projectKey === "logical-shared" || group.meshOffline?.tag === "CB",
    );
    expect(shared).toHaveLength(1);
    expect(shared[0]?.meshOffline).toBeUndefined();
    // A logical project with two unreachable copies still gets exactly one row.
    expect(groups.filter((group) => group.projectKey === "logical-elsewhere")).toHaveLength(1);
  });

  it("keeps a project visible when only an unconnected machine has it", () => {
    const groups = buildSidebarProjectSnapshots({
      projects: [],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) =>
        environmentId === remoteEnvironmentId ? "Cloudbox" : null,
      layout: {
        ...layout,
        machines: { [remoteEnvironmentId]: { tag: "CB" } },
        projectMounts: { "logical-shared": [layout.projectMounts["logical-shared"]![1]!] },
      },
      connectedEnvironmentIds: new Set([primaryEnvironmentId]),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.meshOffline).toMatchObject({ environmentId: remoteEnvironmentId, tag: "CB" });
  });
});

describe("mesh layout project grouping", () => {
  it("gives the project picker one row per logical project, not one per representation", () => {
    const primary = makeProject({
      id: ProjectId.make("project-primary"),
      workspaceRoot: "/work/Atlas",
      repositoryIdentity: null,
    });
    const copy = makeProject({
      id: ProjectId.make("project-copy"),
      environmentId: remoteEnvironmentId,
      workspaceRoot: "/home/user/Atlas",
      repositoryIdentity: null,
    });
    const layout: SidebarWorkspacesConfig = {
      ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
      machines: {
        [primaryEnvironmentId]: { title: "studio", tag: "ST" },
        [remoteEnvironmentId]: { title: "laptop", tag: "LT" },
      },
      projectMounts: {
        "logical-atlas": [
          {
            environmentId: primaryEnvironmentId,
            path: "/work/Atlas",
            projectId: primary.id,
            transport: "git",
            role: "primary",
            createdAt: "",
          },
          {
            environmentId: remoteEnvironmentId,
            path: "/home/user/Atlas",
            projectId: copy.id,
            transport: "mutagen",
            role: "replica",
            source: primaryEnvironmentId,
            createdAt: "",
          },
        ],
      },
    };
    const snapshots = buildSidebarProjectSnapshots({
      layout,
      connectedEnvironmentIds: new Set([primaryEnvironmentId, remoteEnvironmentId]),
      projects: [primary, copy],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.projectKey).toBe("logical-atlas");
    expect(
      buildSidebarProjectPickerEntries({
        groups: pickableProjectGroups(snapshots),
        preferredProjectRef: null,
      }),
    ).toHaveLength(1);
  });
});
