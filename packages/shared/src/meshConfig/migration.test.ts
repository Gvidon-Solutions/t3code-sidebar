import { expect, it } from "@effect/vitest";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { migrateConfig } from "./migration.ts";
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
    aliases: ["desk"],
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
    expect(machineByPeerLabel(config, result!.bindings, label)?.name).toBe("studio");
  expect(machineByPeerLabel(config, result!.bindings, "T3 Code · cloudbox-host")?.name).toBe(
    "cloudbox",
  );
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
