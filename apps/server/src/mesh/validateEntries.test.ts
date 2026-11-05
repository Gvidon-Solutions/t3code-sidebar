import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { validateEntries, validateClientEntries } from "./validateEntries.ts";
const h = "0000000000000.00000.studio";
it.effect("validates config revisions, history and machine bindings before storage", () =>
  Effect.gen(function* () {
    const revision = {
      revision: h,
      doc: { schema: 1, machines: { studio: { label: "ST" } } },
      author: "studio",
      writtenAt: "2026-01-01T00:00:00Z",
    };
    yield* validateEntries({
      "mesh.config": { v: revision, h },
      [`mesh.configHistory/${h}`]: { v: revision, h },
      "mesh.machineBinding/studio": { v: "environment-1", h },
    });
    yield* validateEntries({
      "mesh.config": { v: null, h },
      "mesh.machineBinding/studio": { v: null, h },
    });
    for (const [key, v] of [
      ["mesh.config", { doc: {} }],
      ["mesh.machineBinding/Bad Name", "environment"],
      ["mesh.machineBinding/studio", false],
    ] as const) {
      expect((yield* validateEntries({ [key]: { v, h } }).pipe(Effect.flip)).reason).toBe(
        "invalid_entries",
      );
    }
  }),
);

it.effect("reserves config keys for the config API and validates status/policy families", () =>
  Effect.gen(function* () {
    for (const key of [
      "mesh.config",
      "mesh.configHistory/revision",
      "mesh.machineBinding/studio",
      "mesh.machineMigration/studio",
      "mesh.configStatus/studio",
      "mesh.configReplica/app/studio",
      "mesh.linkPolicy/studio/laptop",
    ])
      expect((yield* validateClientEntries({ [key]: {} }).pipe(Effect.flip)).message).toContain(
        "meshConfig.apply",
      );
    yield* validateClientEntries({ "machine/studio": {} });
    yield* validateEntries({
      "mesh.configStatus/studio": { v: { environmentId: "studio", revision: h, actions: [] }, h },
      "mesh.configReplica/app/studio": { v: true, h },
      "mesh.linkPolicy/studio/laptop": {
        v: { files: "projects", threads: true, replicas: true },
        h,
      },
    });
    for (const [key, value] of [
      ["mesh.configStatus/studio", { environmentId: "studio" }],
      ["mesh.configReplica/app/studio", "bad"],
      ["mesh.linkPolicy/studio/laptop", { files: "root" }],
      ["mesh.configHistory/", null],
      ["mesh.machineBinding/studio", ""],
    ] as const)
      expect((yield* validateEntries({ [key]: { v: value, h } }).pipe(Effect.flip)).reason).toBe(
        "invalid_entries",
      );
  }),
);
