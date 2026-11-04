import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { validateEntries } from "./validateEntries.ts";
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
