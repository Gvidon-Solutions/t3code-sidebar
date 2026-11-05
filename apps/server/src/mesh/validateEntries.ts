import { MeshLayoutError } from "@t3tools/contracts";
import { validateLayoutEntry, type MeshLayoutDocument } from "@t3tools/shared/meshLayout";
import * as Schema from "effect/Schema";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
import * as Effect from "effect/Effect";

export const validateEntries = Effect.fn("MeshLayout.validateEntries")(function* (
  entries: MeshLayoutDocument,
) {
  if (
    Object.keys(entries).filter((key) => !key.startsWith("author/")).length > 5000 ||
    Object.keys(entries).length > 10000
  )
    return yield* new MeshLayoutError({
      reason: "invalid_entries",
      message: "Mesh batch size exceeds limit",
    });
  for (const [key, entry] of Object.entries(entries)) {
    const reason =
      validateLayoutEntry(key, entry) ??
      (new TextEncoder().encode(encodeJson({ [key]: entry })).byteLength > 65536
        ? "entry exceeds 65536 bytes"
        : null);
    if (reason !== null)
      return yield* new MeshLayoutError({
        reason: "invalid_entries",
        message: `${key}: ${reason}`,
      });
  }
});

export const validateClientEntries = Effect.fn("MeshLayout.validateClientEntries")(function* (
  entries: Readonly<Record<string, unknown>>,
) {
  if (
    Object.keys(entries).some((key) =>
      /^mesh\.(?:config|machineBinding|machineMigration|linkPolicy)/.test(key),
    )
  )
    return yield* new MeshLayoutError({
      reason: "invalid_entries",
      message: "Mesh config entries must be changed through meshConfig.apply",
    });
});
