import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG as empty,
  type ReplicaLiveStatus,
  type SidebarProjectMount,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";

import {
  machineChoiceId,
  machineChoiceText,
  machineChoices,
  mergeReplicaStatusLists,
  pendingRows,
  pendingRowsForProject,
  planThreadOnMachine,
  removeRepresentationCopy,
  replicaDriverEnvironment,
  replicaMachineChoices,
  replicaProjectId,
  replicaStatusCopy,
  representationCandidates,
  representationRow,
  replicaExecutionLabel,
  unmanagedSessionLabel,
  replicaStatusDetail,
} from "./replicas.ts";

const primary = (environmentId: string, path = "/work/demo"): SidebarProjectMount => ({
  environmentId,
  path,
  projectId: `project-${environmentId}`,
  transport: "git",
  role: "primary",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const replica = (environmentId: string, source: string): SidebarProjectMount => ({
  environmentId,
  path: "/work/demo",
  transport: "mutagen",
  role: "replica",
  source,
  createdAt: "2026-01-02T00:00:00.000Z",
});

function withReps(
  reps: ReadonlyArray<SidebarProjectMount>,
  rest: Partial<SidebarWorkspacesConfig> = {},
): SidebarWorkspacesConfig {
  return { ...empty, projectMounts: { demo: [...reps] }, ...rest };
}

const status = (
  environmentId: string,
  state: ReplicaLiveStatus["state"],
  patch: Partial<ReplicaLiveStatus> = {},
): ReplicaLiveStatus => ({
  logicalKey: "demo",
  environmentId,
  state,
  conflicts: [],
  problems: [],
  updatedAt: "2026-01-03T00:00:00.000Z",
  ...patch,
});

const displayOf = (environmentId: string, label: string) => ({
  label: `${label} (${environmentId})`,
  tag: environmentId.slice(0, 2).toUpperCase(),
  color: "#123456",
});

describe("thread placement", () => {
  it("is ready when the target already has a registered project", () => {
    const config = withReps([primary("alpha"), { ...replica("beta", "alpha"), projectId: "p2" }]);
    const plan = planThreadOnMachine({ config, logicalKey: "demo", targetEnvironmentId: "beta" });
    expect(plan).toMatchObject({ kind: "ready", projectId: "p2" });
  });

  it("waits with the last stored status when the representation is not registered yet", () => {
    const config = withReps([primary("alpha"), replica("beta", "alpha")], {
      projectMountStatus: {
        demo: { beta: { state: "mounting", conflicts: 2, updatedAt: "2026-01-04T00:00:00.000Z" } },
      },
    });
    const plan = planThreadOnMachine({ config, logicalKey: "demo", targetEnvironmentId: "beta" });
    expect(plan).toMatchObject({
      kind: "pending",
      status: { state: "mounting", conflicts: 2 },
    });
  });

  it("creates a Mutagen replica of the first primary with the caller's timestamp", () => {
    const config = withReps([primary("alpha"), primary("gamma")]);
    const plan = planThreadOnMachine({
      config,
      logicalKey: "demo",
      targetEnvironmentId: "beta",
      createdAt: "2026-02-02T00:00:00.000Z",
    });
    expect(plan).toMatchObject({
      kind: "create",
      rep: {
        environmentId: "beta",
        path: "/work/demo",
        transport: "mutagen",
        role: "replica",
        source: "alpha",
        createdAt: "2026-02-02T00:00:00.000Z",
      },
    });
  });

  it("prefers a primary over another replica as the source", () => {
    const config = withReps([replica("beta", "alpha"), primary("alpha")]);
    const plan = planThreadOnMachine({
      config,
      logicalKey: "demo",
      targetEnvironmentId: "gamma",
    });
    expect(plan.kind === "create" && plan.rep.source).toBe("alpha");
  });
});

describe("planThreadOnMachine", () => {
  it("records the folder's project as primary when the logical project has no representations", () => {
    const plan = planThreadOnMachine({
      config: empty,
      logicalKey: "demo",
      targetEnvironmentId: "beta",
      seed: { environmentId: "alpha", path: "/work/demo", projectId: "p1" },
      createdAt: "2026-02-02T00:00:00.000Z",
    });
    expect(plan.config.projectMounts.demo).toEqual([
      {
        environmentId: "alpha",
        path: "/work/demo",
        projectId: "p1",
        transport: "git",
        role: "primary",
        createdAt: "2026-02-02T00:00:00.000Z",
      },
      {
        environmentId: "beta",
        path: "/work/demo",
        transport: "mutagen",
        role: "replica",
        source: "alpha",
        createdAt: "2026-02-02T00:00:00.000Z",
      },
    ]);
    expect(plan).toMatchObject({ kind: "create", projectId: null });
  });

  it("adds no entry when the target is ready, and projects the ready id", () => {
    const config = withReps([primary("alpha"), { ...replica("beta", "alpha"), projectId: "p2" }]);
    const plan = planThreadOnMachine({
      config,
      logicalKey: "demo",
      targetEnvironmentId: "beta",
    });
    expect(plan.config).toBe(config);
    expect(plan).toMatchObject({ kind: "ready", projectId: "p2" });
  });

  it("leaves an existing pending representation alone", () => {
    const config = withReps([primary("alpha"), replica("beta", "alpha")]);
    const plan = planThreadOnMachine({
      config,
      logicalKey: "demo",
      targetEnvironmentId: "beta",
    });
    expect(plan.config).toBe(config);
    expect(plan).toMatchObject({ kind: "pending", projectId: null });
  });
});

describe("pendingRows", () => {
  it("lists only unregistered representations and merges the live status over the stored one", () => {
    const config = withReps(
      [primary("alpha"), replica("beta", "alpha"), replica("gamma", "alpha")],
      {
        projectMountStatus: {
          demo: {
            gamma: { state: "error", message: "stored", updatedAt: "2026-01-01T00:00:00.000Z" },
          },
        },
      },
    );
    const rows = pendingRows(config, [
      status("beta", "mounting", { progress: 0.42, sessionName: "t3-b" }),
    ]);
    expect(rows.map((row) => [row.rep.environmentId, row.status.state])).toEqual([
      ["beta", "mounting"],
      ["gamma", "error"],
    ]);
    expect(rows[0]?.progress).toBe(0.42);
    expect(rows[1]?.message).toBe("stored");
  });

  it("takes the project id from a live status before the layout carries it", () => {
    const config = withReps([primary("alpha"), replica("beta", "alpha")]);
    const rows = pendingRows(config, [status("beta", "watching", { projectId: "p2" })]);
    expect(rows[0]?.projectId).toBe("p2");
    expect(rows[0]?.status.state).toBe("watching");
  });

  it("keeps registered replicas with conflicts visible until synchronization recovers", () => {
    const config = withReps([
      primary("alpha"),
      { ...replica("beta", "alpha"), projectId: "p2" },
      replica("gamma", "alpha"),
    ]);
    const rows = pendingRows(config, [
      status("beta", "conflict", { conflicts: ["a.ts"] }),
      status("gamma", "conflict", { conflicts: ["b.ts", "c.ts"] }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ conflicts: 1, projectId: "p2" });
    expect(rows[1]).toMatchObject({ conflicts: 2, projectId: null });
    expect(
      pendingRows(config, [status("beta", "watching")]).map((row) => row.rep.environmentId),
    ).toEqual(["gamma"]);
    expect(
      pendingRows(config, [status("beta", "error", { message: "Disk full" })])[0],
    ).toMatchObject({ rep: { environmentId: "beta" }, message: "Disk full" });
  });
});

describe("representationRow", () => {
  it("calls a registered representation Synced when nothing newer is reported", () => {
    const config = withReps([primary("alpha")]);
    const row = representationRow(config, [], "demo", config.projectMounts.demo![0]!);
    expect(row.text).toBe("Synced");
    expect(row.retry).toBeNull();
    const stale = status("alpha", "error", { message: "Old replica route failed" });
    expect(pendingRows(config, [stale])).toEqual([]);
    expect(
      representationRow(config, [stale], "demo", config.projectMounts.demo![0]!),
    ).toMatchObject({ text: "Synced", retry: null });
  });

  it("uses the live error and offers a retry with the row a dialog needs", () => {
    const config = withReps([primary("alpha"), { ...replica("beta", "alpha"), projectId: "p2" }]);
    const row = representationRow(
      config,
      [status("beta", "error", { message: "Disk is full" })],
      "demo",
      config.projectMounts.demo![1]!,
    );
    expect(row.text).toBe("Disk is full");
    expect(row.retry).toMatchObject({
      logicalKey: "demo",
      message: "Disk is full",
      rep: { environmentId: "beta" },
    });
  });
});

describe("replicaProjectId", () => {
  it("reads the layout first and falls back to the live status", () => {
    const config = withReps([primary("alpha"), { ...replica("beta", "alpha"), projectId: "p2" }]);
    expect(replicaProjectId(config, [], "demo", "beta")).toBe("p2");
    expect(
      replicaProjectId(config, [status("gamma", "watching", { projectId: "p3" })], "demo", "gamma"),
    ).toBe("p3");
    expect(replicaProjectId(config, [], "demo", "gamma")).toBeNull();
  });
});

describe("mergeReplicaStatusLists", () => {
  it("merges every machine's list by (logicalKey, environmentId), latest value winning", () => {
    const merged = mergeReplicaStatusLists([
      {
        environmentId: "alpha",
        replicas: [status("beta", "pending"), status("gamma", "mounting")],
      },
      {
        environmentId: "beta",
        replicas: [status("beta", "watching", { updatedAt: "2026-01-09T00:00:00.000Z" })],
      },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((row) => row.environmentId === "beta")?.state).toBe("watching");
  });
});

describe("replicaDriverEnvironment", () => {
  it("always drives from the replica, including when machine facts are unavailable", () => {
    expect(replicaDriverEnvironment(empty, replica("beta", "alpha"))).toBe("beta");
    expect(
      replicaDriverEnvironment(empty, { ...replica("beta", "alpha"), role: "primary" }),
    ).toBeNull();
  });
});

describe("replicaMachineChoices", () => {
  it("keeps connected machines and disables those without the mesh RPCs with a reason", () => {
    const choices = replicaMachineChoices(
      empty,
      [
        { environmentId: "alpha", label: "Alpha", connected: true, supportsMesh: true },
        { environmentId: "beta", label: "Beta", connected: true, supportsMesh: false },
        { environmentId: "gamma", label: "Gamma", connected: false, supportsMesh: true },
      ],
      displayOf,
    );
    expect(choices.map((choice) => choice.environmentId)).toEqual(["alpha", "beta"]);
    expect(choices[1]).toMatchObject({
      disabled: true,
      reason: "update this server to use the mesh",
    });
  });
});

describe("replicaStatusCopy", () => {
  const base = {
    progress: null,
    conflicts: 0,
    message: null,
    targetLabel: "Boreal",
    sourceLabel: "atlas",
  };
  it("names the machine and the percentage while mounting", () => {
    expect(replicaStatusCopy({ ...base, state: "mounting", progress: 0.42 })).toBe(
      "Copying files to Boreal… 42%",
    );
    expect(replicaStatusCopy({ ...base, state: "mounting" })).toBe("Copying files to Boreal…");
  });
  it("explains a manual copy instead of repeating the server phrase", () => {
    expect(replicaStatusCopy({ ...base, state: "watching", message: "Manual copy" })).toBe(
      "Not synced automatically",
    );
  });
  it("says Synced, counts conflicts and pluralizes", () => {
    expect(replicaStatusCopy({ ...base, state: "watching" })).toBe("Synced");
    expect(replicaStatusCopy({ ...base, state: "conflict", conflicts: 1 })).toBe("1 conflict");
    expect(replicaStatusCopy({ ...base, state: "conflict", conflicts: 2 })).toBe("2 conflicts");
  });
  it("turns unreachable errors into the Settings › Mesh route hint", () => {
    expect(
      replicaStatusCopy({
        ...base,
        state: "error",
        message: "Boreal cannot reach atlas and back. Add an ssh route.",
      }),
    ).toBe("Can't reach atlas");
    expect(
      replicaStatusDetail({
        ...base,
        state: "error",
        message: "Boreal cannot reach atlas and back. Add an ssh route.",
      }),
    ).toBe("Can't reach atlas from Boreal. Check the SSH route in Mesh config");
    expect(replicaStatusCopy({ ...base, state: "error", message: "Disk is full" })).toBe(
      "Disk is full",
    );
  });
});

it("shows automatic resolutions as a calm note during mounting and after sync", () => {
  for (const state of ["mounting", "watching"] as const) {
    expect(
      replicaStatusCopy({
        state,
        progress: null,
        conflicts: 0,
        message: "Resolved 2 conflicts automatically · copies in .t3-conflicts",
        targetLabel: "Replica",
        sourceLabel: "Primary",
      }),
    ).toBe("2 conflicts resolved automatically · copies in .t3-conflicts");
  }
});

it("keeps skipped paths calm through mounting, persisted status and live recovery", () => {
  const rep = { ...replica("beta", "alpha"), projectId: "ready" };
  const warning = {
    state: "watching" as const,
    skipped: 1,
    skippedPaths: [{ path: "outside", error: "absolute symlink" }],
    message: "1 file skipped (symlinks outside the project)",
    updatedAt: "",
  };
  const config = {
    ...empty,
    projectMounts: { demo: [rep] },
    projectMountStatus: { demo: { beta: warning } },
  };
  expect(representationRow(config, [], "demo", rep)).toMatchObject({
    text: warning.message,
    status: { skipped: 1, skippedPaths: warning.skippedPaths },
    retry: null,
  });
  expect(
    replicaStatusCopy({
      state: "mounting",
      progress: 0.5,
      conflicts: 0,
      message: warning.message,
      targetLabel: "Beta",
      sourceLabel: "Alpha",
    }),
  ).toBe(warning.message);
  expect(representationRow(config, [status("beta", "watching")], "demo", rep)).toMatchObject({
    text: "Synced",
    retry: null,
  });
  expect(
    representationRow(config, [status("beta", "watching")], "demo", rep).status.skipped,
  ).toBeUndefined();
});

it("identifies replica git ownership without offering local git controls", () => {
  const config = {
    ...empty,
    machines: { studio: { label: "Studio" } },
    projectMounts: {
      demo: [
        {
          environmentId: "studio",
          projectId: "source",
          role: "primary" as const,
          transport: "git" as const,
          path: "/project",
          createdAt: "",
        },
        {
          environmentId: "cloudbox",
          projectId: "copy",
          source: "studio",
          role: "replica" as const,
          transport: "mutagen" as const,
          path: "/copy",
          createdAt: "",
        },
      ],
    },
  };
  expect(replicaExecutionLabel(config, "cloudbox", "copy")).toBe("git on Studio · t3 run");
  expect(replicaExecutionLabel(config, "cloudbox", "source", "studio")).toBe(
    "git on Studio · t3 run",
  );
  expect(
    replicaExecutionLabel(
      {
        ...config,
        projectMounts: {
          demo: [config.projectMounts.demo[0]!, replica("cloudbox", "studio")],
        },
      },
      "cloudbox",
      "source",
      "studio",
    ),
  ).toBe("git on Studio · t3 run");
  expect(replicaExecutionLabel(config, "studio", "source")).toBeNull();
});

describe("shared machine choices", () => {
  const choicesConfig = {
    ...empty,
    machines: {
      alpha: { label: "atlas", tag: "AT" },
      beta: { label: "Boreal", tag: "BO" },
    },
  };

  it("resolves display facts and keeps only connected machines", () => {
    const choices = machineChoices(choicesConfig, [
      { environmentId: "alpha", label: "atlas", connected: true, supportsMesh: true },
      { environmentId: "beta", label: "Boreal", connected: true, supportsMesh: false },
      { environmentId: "gamma", label: "lab", connected: false, supportsMesh: true },
    ]);
    expect(choices.map((choice) => [choice.environmentId, choice.tag, choice.label])).toEqual([
      ["alpha", "AT", "atlas"],
      ["beta", "BO", "Boreal"],
    ]);
    expect(machineChoiceId(choices[0]!)).toBe("machine:alpha");
    expect(machineChoiceText(choices[1]!)).toBe("BO  Boreal (update this server to use the mesh)");
  });

  it("filters pending rows by logical project", () => {
    const config = withReps([primary("alpha"), replica("beta", "alpha")]);
    const rows = pendingRowsForProject(config, [status("beta", "mounting")], "demo");
    expect(rows.map((row) => row.rep.environmentId)).toEqual(["beta"]);
    expect(pendingRowsForProject(config, [status("beta", "mounting")], "other")).toEqual([]);
  });

  it("lists only enabled machines that are not already represented", () => {
    const candidates = representationCandidates(
      [
        { environmentId: "alpha", disabled: false },
        { environmentId: "beta", disabled: true },
        { environmentId: "gamma", disabled: false },
      ],
      new Set(["alpha"]),
    );
    expect(candidates.map((machine) => machine.environmentId)).toEqual(["gamma"]);
  });

  it("shares the remove and adopt copy", () => {
    expect(removeRepresentationCopy({ role: "replica", otherCopies: [] })).toMatchObject({
      title: "Remove this copy?",
      canRemove: true,
    });
    expect(removeRepresentationCopy({ role: "primary", otherCopies: [] }).message).toContain(
      "ordinary folder",
    );
    const blocked = removeRepresentationCopy({
      role: "primary",
      otherCopies: [{ environmentId: "beta", label: "Cloudbox" }],
    });
    expect(blocked.canRemove).toBe(false);
    expect(blocked.message).toContain("Make another copy the main copy first");
    expect(blocked.makePrimary).toEqual([
      { environmentId: "beta", label: "Cloudbox", actionLabel: "Make Cloudbox the main copy" },
    ]);
    expect(
      unmanagedSessionLabel({
        name: null,
        alpha: { path: "/a" },
        beta: { path: "/b" },
      }),
    ).toBe("Adopt existing sync · /a ↔ /b");
  });
});
