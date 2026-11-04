import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { MeshConfigDocument } from "@t3tools/contracts";
import {
  defaults,
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
  it("round trips unknown fields at every object level through JSON and YAML", () => {
    const input = {
      schema: 1,
      future: { x: true },
      machines: { studio: { future: 4, ssh: { user: "dev", future: 7 } } },
      agents: { aliases: { sol: { harness: "codex", model: "model", future: false } } },
    };
    expect(encodeConfig(parseConfig(JSON.stringify(input)))).toEqual(input);
    expect(parseConfig("schema: 1\nmachines:\n  studio:\n    label: ST\nfuture: yes\n")).toEqual({
      schema: 1,
      machines: { studio: { label: "ST" } },
      future: "yes",
    });
  });
  it("rejects malformed fields with their paths", () => {
    for (const input of [
      { schema: "1", machines: {} },
      { schema: 1, machines: { "Bad Name": {} } },
      { schema: 1, machines: { studio: { ssh: { port: 0 } } } },
    ])
      expect(() => parseConfig(input)).toThrow();
    expect(() =>
      parseConfig({ schema: 1, machines: {}, links: { default: { files: "root" } } }),
    ).toThrow(/files/);
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
      machines: { studio: { title: "Studio" } },
      agents: { aliases: { sol: { harness: "codex", model: "model" } } },
    });
    expect(machineByName(config, "studio")?.title).toBe("Studio");
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
    const errors = referenceErrors(
      parseConfig({
        schema: 2,
        machines: { studio: { reach: { via: "laptop" } }, laptop: { reach: { via: "studio" } } },
        links: {
          overrides: [{ between: ["studio", "absent"] }, { between: ["absent", "studio"] }],
        },
        replicas: { rules: [{ project: "*", on: "missing", when: "manual" }] },
      }),
    );
    expect(errors.map((e) => e.path)).toEqual([
      "schema",
      "machines.studio.reach.via",
      "machines.laptop.reach.via",
      "links.overrides.0.between.1",
      "links.overrides.1.between.0",
      "links.overrides.1.between",
      "replicas.rules.0.on",
    ]);
  });
});
