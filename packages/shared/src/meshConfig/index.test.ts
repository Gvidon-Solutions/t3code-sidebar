import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { stringify } from "yaml";
import { MeshConfigDocument } from "@t3tools/contracts";
import { materialize } from "../meshLayout/materialize.ts";
import type { Json } from "../meshLayout/document.ts";
import {
  defaults,
  bindingsFromLayout,
  machineByName,
  machineByEnvironment,
  modelAlias,
  effectiveLinkPermissions,
  parseConfig,
  projectPolicy,
  referenceErrors,
  replicaRules,
} from "./index.ts";

const encodeConfig = Schema.encodeSync(MeshConfigDocument);
describe("mesh config", () => {
  it("leaves model aliases to user configuration", () => {
    expect(defaults().agents?.aliases).toEqual({});
  });
  it("round trips unknown fields at every object level through JSON and YAML", () => {
    const input = {
      schema: 1,
      future: { x: true },
      t3: { version: "0.1.7-test.1", future: true },
      machines: {
        studio: {
          label: "ST",
          title: "Studio",
          color: "blue",
          future: 4,
          reach: { address: "https://studio.example", future: true },
          ssh: { user: "dev", port: 22, future: 7 },
          bootstrap: { ssh: "dev@studio", os: "linux", future: true },
        },
        laptop: { reach: { via: "studio", future: true } },
      },
      links: {
        future: true,
        default: { files: "projects", replicas: true, threads: true, future: true },
        overrides: [{ between: ["studio", "laptop"], files: "all", future: true }],
      },
      ssh: { mode: "existing", future: true },
      projects: {
        future: true,
        defaults: { conflicts: "primary-wins", replica: "lite", ignore: [], future: true },
        overrides: [{ project: "app*", ignore: ["/data"], future: true }],
      },
      replicas: {
        ignore: ["*.log"],
        future: true,
        rules: [{ project: "*", on: "laptop", when: "always", future: true }],
      },
      agents: {
        aliases: { sol: { harness: "codex", model: "model", future: false } },
        instructions: "Shared instructions",
        future: true,
      },
    };
    expect(encodeConfig(parseConfig(JSON.stringify(input)))).toEqual(input);
    expect(encodeConfig(parseConfig(stringify(input)))).toEqual(input);
    expect(parseConfig("schema: 1\nmachines:\n  studio:\n    label: ST\nfuture: yes\n")).toEqual({
      schema: 1,
      machines: { studio: { label: "ST" } },
      future: "yes",
    });
  });
  it("rejects malformed fields with their paths", () => {
    expect(() => parseConfig("schema: 1\nmachines: {}\nfuture: &loop {self: *loop}\n")).toThrow(
      /JSON/,
    );
    expect(() => parseConfig("schema: 1\nmachines: {}\nfuture: .inf\n")).toThrow(/JSON/);
    const cases: readonly [Record<string, unknown>, RegExp][] = [
      [{ schema: "1" }, /schema/],
      [{ machines: { "Bad Name": {} } }, /machines.*|Machine names must be slugs/s],
      [{ t3: { version: 3 } }, /version/],
      [{ machines: { studio: { label: 1 } } }, /label/],
      [{ machines: { studio: { title: false } } }, /title/],
      [{ machines: { studio: { color: [] } } }, /color/],
      [{ machines: { studio: { aliases: [1] } } }, /aliases/],
      [{ machines: { studio: { reach: { via: "Bad Name" } } } }, /reach/],
      [{ machines: { studio: { ssh: { port: 0 } } } }, /port/],
      [{ machines: { studio: { ssh: { user: 1 } } } }, /user/],
      [{ machines: { studio: { bootstrap: { ssh: true, os: 1 } } } }, /bootstrap/],
      [{ links: { default: { files: "root" } } }, /files/],
      [{ links: { default: { replicas: "yes" } } }, /replicas/],
      [{ links: { default: { threads: 1 } } }, /threads/],
      [{ links: { overrides: [{ between: ["studio"] }] } }, /between/],
      [{ ssh: { mode: "other" } }, /mode/],
      [{ projects: { defaults: { conflicts: "authority" } } }, /conflicts/],
      [{ projects: { defaults: { replica: "other" } } }, /replica/],
      [{ projects: { defaults: { ignore: [1] } } }, /ignore/],
      [{ projects: { overrides: [{ project: 1 }] } }, /project/],
      [{ replicas: { ignore: [false] } }, /ignore/],
      [{ replicas: { rules: [{ project: "*", on: "studio", when: "other" }] } }, /when/],
      [{ agents: { aliases: { sol: { harness: 1, model: "model" } } } }, /harness/],
      [{ agents: { aliases: { sol: { harness: "codex", model: 1 } } } }, /model/],
      [{ agents: { instructions: false } }, /instructions/],
    ];
    for (const [patch, path] of cases)
      expect(() => parseConfig({ schema: 1, machines: {}, ...patch })).toThrow(path);
  });
  it("merges permissions symmetrically and project ignores without duplicates", () => {
    const config = parseConfig({
      schema: 1,
      machines: { studio: {}, laptop: {} },
      links: {
        default: { threads: false },
        overrides: [{ between: ["studio", "laptop"], files: "all" }],
      },
      projects: {
        defaults: { ignore: ["/data"] },
        overrides: [
          {
            project: "app*",
            conflicts: "newest-wins",
            replica: "full",
            ignore: ["/data", "cache"],
          },
        ],
      },
      replicas: { ignore: ["*.log"], rules: [{ project: "app*", on: "laptop", when: "always" }] },
    });
    expect(effectiveLinkPermissions(config, "laptop", "studio")).toMatchObject({
      files: "all",
      threads: false,
      replicas: true,
    });
    expect(effectiveLinkPermissions(defaults(), "x", "y").files).toBe("projects");
    expect(projectPolicy(config, "app")).toMatchObject({
      conflicts: "newest-wins",
      replica: "full",
    });
    expect(projectPolicy(config, "app").ignore.filter((p) => p === "/data")).toHaveLength(1);
    expect(replicaRules(config, "app")).toHaveLength(1);
    expect(replicaRules(config, "other")).toHaveLength(0);
  });
  it("resolves stable machine bindings and configured model aliases", () => {
    const config = parseConfig({
      schema: 1,
      machines: { studio: { title: "Studio", name: "future-display-name" } },
      agents: { aliases: { sol: { harness: "codex", model: "model" } } },
    });
    expect(machineByName(config, "studio")?.title).toBe("Studio");
    expect(machineByName(config, "studio")?.name).toBe("future-display-name");
    const h = "0000000000000.00000.studio";
    expect(
      materialize({
        "mesh.config": {
          v: { revision: h, doc: config as Json, author: "studio", writtenAt: "" },
          h,
        },
        "mesh.machineBinding/studio": { v: "environment-1", h },
        "machine/environment-1": { v: { title: "Old title", label: "Old label" }, h },
      }).machines["environment-1"],
    ).toMatchObject({ title: "Studio", label: "Studio" });
    expect(machineByName(config, "missing")).toBeUndefined();
    expect(machineByEnvironment(config, { studio: "environment-1" }, "environment-1")).toEqual({
      name: "studio",
      title: "Studio",
    });
    expect(machineByEnvironment(config, {}, "missing")).toBeUndefined();
    expect(modelAlias(config, "sol")).toEqual({ harness: "codex", model: "model" });
    expect(modelAlias(config, "missing")).toBeUndefined();
  });
  it("reports unsupported schemas, unknown references, cycles and duplicate pairs", () => {
    const errors = referenceErrors({
      ...parseConfig({
        schema: 1,
        machines: { studio: { reach: { via: "laptop" } }, laptop: { reach: { via: "studio" } } },
        links: {
          overrides: [{ between: ["studio", "absent"] }, { between: ["absent", "studio"] }],
        },
        replicas: { rules: [{ project: "*", on: "missing", when: "manual" }] },
      }),
      schema: 2,
    });
    expect(() => parseConfig({ schema: 2, machines: {} })).toThrow();
    expect(errors.map((e) => e.path)).toEqual([
      "schema",
      "machines.studio.reach.via",
      "machines.laptop.reach.via",
      "links.overrides.0.between.1",
      "links.overrides.1.between.0",
      "links.overrides.1.between",
      "replicas.rules.0.on",
    ]);
    expect(errors.map((e) => e.message)).toEqual([
      "Unsupported schema: 2",
      "Reach route contains a cycle",
      "Reach route contains a cycle",
      "Unknown machine: absent",
      "Unknown machine: absent",
      "Overlapping link override",
      "Unknown machine: missing",
    ]);
    expect(
      referenceErrors(
        parseConfig({
          schema: 1,
          machines: { studio: {} },
          links: { overrides: [{ between: ["studio", "studio"] }] },
        }),
      ),
    ).toEqual([{ path: "links.overrides.0.between", message: "Overlapping link override" }]);
  });
});

it("rejects conflicting overlapping project globs but merges compatible ignore overrides", () => {
  const input = {
    schema: 1,
    machines: {},
    projects: {
      overrides: [
        { project: "app*", replica: "lite", conflicts: "primary-wins", ignore: ["a"] },
        { project: "*api", replica: "full", conflicts: "newest-wins", ignore: ["b"] },
      ],
    },
  };
  expect(referenceErrors(parseConfig(input)).map((e) => e.path)).toEqual([
    "projects.overrides.1.conflicts",
    "projects.overrides.1.replica",
  ]);
  expect(
    referenceErrors(
      parseConfig({
        ...input,
        projects: {
          overrides: [
            { project: "web*", replica: "lite" },
            { project: "api*", replica: "full" },
          ],
        },
      }),
    ),
  ).toEqual([]);
  expect(
    referenceErrors(
      parseConfig({
        ...input,
        projects: {
          overrides: [
            { project: "*", ignore: ["a"] },
            { project: "app?", ignore: ["b"] },
          ],
        },
      }),
    ),
  ).toEqual([]);
  const unicode = parseConfig({
    schema: 1,
    machines: {},
    projects: {
      overrides: [
        { project: "app😀", conflicts: "primary-wins" },
        { project: "app?", conflicts: "newest-wins" },
      ],
    },
  });
  expect(projectPolicy(unicode, "app😀").conflicts).toBe("newest-wins");
  expect(referenceErrors(unicode)).toEqual([
    {
      path: "projects.overrides.1.conflicts",
      message: "Overlapping project override with projects.overrides.0",
    },
  ]);
});

it("seeds code-only ignores for new configs without expanding existing configs", () => {
  const initial = defaults();
  for (const pattern of [
    ".venv",
    "__pycache__",
    "*.pyc",
    "*.tar.gz",
    "*.pdf",
    "*.gguf",
    "*.parquet",
    "dist",
    "/build",
    "/.t3",
  ])
    expect(projectPolicy(initial, "Application").ignore).toContain(pattern);
  expect(
    projectPolicy({ schema: 1, machines: {}, replicas: { ignore: ["/private"] } }, "Application")
      .ignore,
  ).not.toContain("*.pdf");
});

it("ignores malformed encoded binding keys", () => {
  expect(bindingsFromLayout({ "mesh.machineBinding/bad%": { v: "studio" } })).toEqual({});
});
