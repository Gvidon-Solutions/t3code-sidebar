import { expect, it } from "@effect/vitest";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { migrateConfig, extractConfigMigration, machineByPeerLabel } from "./migration.ts";
import { effectiveLinkPermissions, parseConfig, referenceErrors } from "./index.ts";
it("migrates a three-machine layout and existing routes, aliases, ignores and permissions once", () => {
  const layout = {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    machines: {
      a: {
        title: "Studio",
        label: "Legacy Studio",
        tag: "ST",
        color: "blue",
        aliases: ["desk"],
        reach: { b: { ssh: "dev@cloudbox:2222", identityFile: "/keys/test" } },
      },
      b: { label: "Cloudbox", tag: "CB" },
      c: { label: "Laptop", tag: "LT" },
    },
    projectTitles: { app: "Application" },
    projectMounts: {
      app: [
        {
          environmentId: "a",
          path: "/app",
          role: "primary" as const,
          transport: "git" as const,
          createdAt: "",
          ignores: ["/data"],
        },
      ],
    },
  };
  const result = migrateConfig(
    {},
    layout,
    { environmentId: "a", label: "studio-host" },
    [{ environmentId: "b", label: "cloudbox-host" }],
    ["*.log"],
  );
  expect(result?.bindings).toEqual({ studio: "a", cloudbox: "b", laptop: "c" });
  expect(result?.doc.machines.studio).toMatchObject({
    title: "Studio",
    label: "ST",
    color: "blue",
  });
  expect(result?.doc.machines.cloudbox?.ssh).toMatchObject({
    user: "dev",
    port: 2222,
    host: "cloudbox",
  });
  const config = parseConfig(result?.doc);
  expect(referenceErrors(config)).toEqual([]);
  for (const label of ["Studio", "Legacy Studio", "T3 Code · studio-host"])
    expect(
      machineByPeerLabel(
        config,
        result!.bindings,
        label,
        Object.fromEntries(
          Object.entries(result!.migration).map(([name, value]) => [name, value.peerLabels]),
        ),
      )?.name,
    ).toBe("studio");
  expect(
    machineByPeerLabel(
      config,
      result!.bindings,
      "T3 Code · cloudbox-host",
      Object.fromEntries(
        Object.entries(result!.migration).map(([name, value]) => [name, value.peerLabels]),
      ),
    )?.name,
  ).toBe("cloudbox");
  expect(effectiveLinkPermissions(config, "studio", "cloudbox").files).toBe("projects");
  expect(effectiveLinkPermissions(config, "studio", "new-machine").files).toBe("projects");
  expect(config.replicas?.ignore).toEqual(["*.log"]);
  expect(config.projects?.overrides).toEqual([{ project: "Application", ignore: ["/data"] }]);
  expect(
    migrateConfig(
      { "mesh.config": { v: null, h: "0000000000000.00000.studio" } },
      layout,
      { environmentId: "a", label: "Studio" },
      [],
      [],
    ),
  ).toBeUndefined();
});

it("keeps migration-only peer identities and SSH routes outside the public config document", () => {
  const migrated = migrateConfig(
    {
      "machine/a": {
        h: "0000000000000.00000.studio",
        v: { title: "Studio", aliases: ["desk"], reach: { b: { ssh: "dev@cloudbox" } } },
      },
    },
    {
      ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
      machines: {
        a: { title: "Studio", aliases: ["desk"] },
        b: { title: "Cloudbox" },
      },
    },
    { environmentId: "a", label: "studio-host" },
    [],
    [],
  );
  expect(Object.keys(migrated!.doc).sort()).toEqual([
    "agents",
    "links",
    "machines",
    "projects",
    "replicas",
    "schema",
    "ssh",
  ]);
  for (const machine of Object.values(migrated!.doc.machines)) {
    expect(
      Object.keys(machine).every((key) =>
        ["title", "label", "color", "reach", "ssh"].includes(key),
      ),
    ).toBe(true);
    expect(
      Object.keys(machine.ssh ?? {}).every((key) => ["host", "user", "port"].includes(key)),
    ).toBe(true);
  }
  expect(Object.keys(migrated!.doc.machines.studio!)).toEqual(["title"]);
  expect(Object.keys(migrated!.doc.machines.cloudbox!.ssh ?? {})).toEqual(["host", "user"]);
  expect(JSON.stringify(migrated!.doc)).not.toContain("legacyPeerLabels");
  expect(migrated!.migration.studio?.peerLabels).toContain("studio-host");
});

it("extracts existing internal data from current and history without dropping future public fields", () => {
  const revision = {
    revision: "r1",
    author: "studio",
    writtenAt: "",
    doc: {
      schema: 1,
      machines: {
        studio: {
          title: "Studio",
          legacyPeerLabels: ["old-host"],
          future: "kept",
          ssh: { user: "dev", host: "old-host", routes: {} },
        },
      },
      future: { enabled: true },
    },
  };
  const document = {
    "mesh.config": { v: revision, h: "0000000000001.00000.studio" },
    "mesh.configHistory/r1": { v: revision, h: "0000000000001.00000.studio" },
  };
  expect(
    extractConfigMigration(
      {
        "mesh.config": {
          ...document["mesh.config"],
          v: {
            ...revision,
            doc: {
              schema: 1,
              machines: { studio: { ssh: { host: "personal-studio" } } },
              ssh: { mode: "existing" },
            },
          },
        },
      },
      "0000000000002.00000.studio",
    ),
  ).toEqual({});
  const entries = extractConfigMigration(document, "0000000000002.00000.studio");
  expect(entries["mesh.machineMigration/studio"]?.v).toEqual({
    peerLabels: ["old-host"],
    ssh: { host: "old-host", routes: {} },
  });
  const clean = {
    ...revision,
    doc: {
      ...revision.doc,
      machines: {
        studio: { title: "Studio", future: "kept", ssh: { user: "dev", host: "old-host" } },
      },
    },
  };
  expect(entries["mesh.config"]?.v).toEqual(clean);
  expect(entries["mesh.configHistory/r1"]?.v).toEqual(clean);
  expect(extractConfigMigration({ ...document, ...entries }, "0000000000003.00000.studio")).toEqual(
    {},
  );
});

it("carries all nine replica ignore lists even when only two layout titles were persisted", () => {
  const projects = Array.from({ length: 9 }, (_, i) => ({
    environmentId: "cloudbox",
    path: `/copies/app-${i}`,
    title: `Application ${i}`,
  }));
  const layout = {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    projectTitles: { "lp-0": "Application 0", "legacy-1": "Application 1" },
    projectMounts: Object.fromEntries(
      projects.map((project, i) => [
        i === 1 ? "legacy-1" : `lp-${i}`,
        [
          {
            environmentId: "studio",
            path: `/work/app-${i}`,
            role: "primary" as const,
            transport: "git" as const,
            createdAt: "",
          },
          {
            environmentId: project.environmentId,
            path: project.path,
            role: "replica" as const,
            transport: "mutagen" as const,
            source: "studio",
            ignores: [
              "/data",
              ...Array.from({ length: 40 }, (_, n) => `/generated-${i}-${n}`),
              "/data",
            ],
            createdAt: "",
          },
        ],
      ]),
    ),
  };
  const result = migrateConfig(
    {},
    layout,
    { environmentId: "cloudbox", label: "Cloudbox" },
    [],
    [],
    projects,
  )!;
  expect(result.doc.projects?.overrides).toHaveLength(9);
  for (const [i, override] of result.doc.projects!.overrides!.entries()) {
    expect(override.project).toBe(`Application ${i}`);
    expect(override.ignore).toHaveLength(41);
    expect(override.ignore).toContain(`/generated-${i}-39`);
  }
  const sharedTitle = migrateConfig(
    {},
    { ...layout, projectTitles: { ...layout.projectTitles, "lp-8": "Application 0" } },
    { environmentId: "cloudbox", label: "Cloudbox" },
    [],
    [],
    projects,
  )!;
  expect(sharedTitle.doc.projects?.overrides).toHaveLength(8);
  expect(
    sharedTitle.doc.projects?.overrides?.find((rule) => rule.project === "Application 0"),
  ).toMatchObject({
    ignore: expect.arrayContaining(["/data", "/generated-0-39", "/generated-8-39"]),
  });
  expect(sharedTitle.doc.projects?.overrides?.[0]?.ignore).toHaveLength(81);
  expect(
    migrateConfig(
      { "mesh.config": { v: null, h: "0000000000000.00000.studio" } },
      layout,
      { environmentId: "cloudbox", label: "Cloudbox" },
      [],
      [],
      projects,
    ),
  ).toBeUndefined();
});
