import { expect, it } from "@effect/vitest";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { migrateConfig, extractConfigMigration } from "./migration.ts";
import {
  effectiveLinkPermissions,
  machineByPeerLabel,
  parseConfig,
  referenceErrors,
} from "./index.ts";
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
  expect(effectiveLinkPermissions(config, "studio", "cloudbox").files).toBe("all");
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
    {},
    {
      ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
      machines: {
        a: { title: "Studio", aliases: ["desk"], reach: { b: { ssh: "dev@cloudbox" } } },
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
    expect(Object.keys(machine.ssh ?? {}).every((key) => ["user", "port"].includes(key))).toBe(
      true,
    );
  }
  expect(Object.keys(migrated!.doc.machines.studio!)).toEqual(["title"]);
  expect(Object.keys(migrated!.doc.machines.cloudbox!.ssh ?? {})).toEqual(["user"]);
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
  const entries = extractConfigMigration(document, "0000000000002.00000.studio");
  expect(entries["mesh.machineMigration/studio"]?.v).toEqual({
    peerLabels: ["old-host"],
    ssh: { host: "old-host", routes: {} },
  });
  const clean = {
    ...revision,
    doc: {
      ...revision.doc,
      machines: { studio: { title: "Studio", future: "kept", ssh: { user: "dev" } } },
    },
  };
  expect(entries["mesh.config"]?.v).toEqual(clean);
  expect(entries["mesh.configHistory/r1"]?.v).toEqual(clean);
  expect(extractConfigMigration({ ...document, ...entries }, "0000000000003.00000.studio")).toEqual(
    {},
  );
});
