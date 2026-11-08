import upgradeFixture from "../../../../../packages/client-runtime/src/state/meshLayout/fixtures/upgrade.json";
import { materialize, merge, migrateLogicalProjectIds } from "@t3tools/shared/meshLayout";
import {
  emptyMeshLayoutState,
  mergeMeshLayoutSnapshot,
} from "@t3tools/client-runtime/state/mesh-layout-client";
import { projectMachineStrip } from "@t3tools/client-runtime/state/mesh-layout";
import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG as empty,
  type ReplicaLiveStatus,
  type SidebarProjectMount,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";

import {
  machineSubactions,
  mobileMachineChoices,
  mobilePendingReplicaItems,
} from "./replicas.logic";

const primary = (environmentId: string): SidebarProjectMount => ({
  environmentId,
  path: "/work/demo",
  projectId: `project-${environmentId}`,
  transport: "git",
  role: "primary",
  createdAt: "",
});

const replica = (environmentId: string, source: string): SidebarProjectMount => ({
  environmentId,
  path: "/work/demo",
  transport: "mutagen",
  role: "replica",
  source,
  createdAt: "",
});

const config: SidebarWorkspacesConfig = {
  ...empty,
  machines: {
    alpha: { label: "atlas", tag: "AT" },
    beta: { label: "Boreal", tag: "BO" },
  },
  projectMounts: { demo: [primary("alpha"), replica("beta", "alpha")] },
};

const live = (environmentId: string, patch: Partial<ReplicaLiveStatus>): ReplicaLiveStatus => ({
  logicalKey: "demo",
  environmentId,
  state: "mounting",
  conflicts: [],
  problems: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

describe("mobileMachineChoices", () => {
  it("lists connected machines and explains an unsupported one", () => {
    const choices = mobileMachineChoices(config, [
      { environmentId: "alpha", label: "atlas", connected: true, supportsMesh: true },
      { environmentId: "beta", label: "Boreal", connected: true, supportsMesh: false },
      { environmentId: "gamma", label: "lab", connected: false, supportsMesh: true },
    ]);
    expect(choices.map((choice) => choice.tag)).toEqual(["AT", "BO"]);
    expect(choices[1]).toMatchObject({
      disabled: true,
      reason: "update this server to use the mesh",
    });
  });
});

describe("machineSubactions", () => {
  it("marks an unsupported machine disabled and puts the reason in the title", () => {
    const actions = machineSubactions(
      mobileMachineChoices(config, [
        { environmentId: "beta", label: "Boreal", connected: true, supportsMesh: false },
      ]),
    );
    expect(actions).toEqual([
      {
        id: "machine:beta",
        title: "BO  Boreal (update this server to use the mesh)",
        disabled: true,
      },
    ]);
  });
});

describe("mobilePendingReplicaItems", () => {
  it("shows the mounting progress and the machine that drives the retry", () => {
    const driving = {
      ...config,
      machines: {
        ...config.machines,
        beta: { ...config.machines.beta, reach: { alpha: { ssh: "atlas.local" } } },
      },
    };
    const items = mobilePendingReplicaItems(driving, [live("beta", { progress: 0.42 })], "demo");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      tag: "BO",
      label: "Boreal",
      text: "Mounting on Boreal… 42%",
      retryEnvironmentId: "beta",
    });
  });

  it("does not list another project's replicas", () => {
    expect(mobilePendingReplicaItems(config, [live("beta", {})], "other")).toEqual([]);
  });
});

it("keeps the unreachable primary beside its replica after a phone cache upgrade", () => {
  const legacy = "studio:/work/application";
  const cachedDocument = {
    [`rep/${encodeURIComponent(legacy)}/studio`]: {
      v: {
        environmentId: "studio",
        path: "/work/application",
        transport: "git",
        role: "primary",
        createdAt: "",
      },
      h: "0000000000002.00000.phone",
    },
  };
  const migrated = migrateLogicalProjectIds(merge(cachedDocument, upgradeFixture.document));
  const state = mergeMeshLayoutSnapshot(
    {
      ...emptyMeshLayoutState(),
      snapshot: {
        environmentId: "studio",
        document: migrated,
        config: materialize(migrated),
      },
    },
    { ...upgradeFixture, config: materialize(upgradeFixture.document) },
  );
  const config = state.snapshot!.config;
  const strip = projectMachineStrip(
    config,
    {
      projectKey: "lp-application",
      environmentIds: ["cloudbox"],
      knownEnvironmentIds: ["cloudbox"],
    },
    [],
  );
  expect(strip.chips.map((chip) => [chip.machine.tag, chip.role])).toEqual([
    ["ST", "primary"],
    ["CB", "replica"],
  ]);
});
