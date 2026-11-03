import { MeshLayoutError } from "@t3tools/contracts";
import type { MeshLayoutDocument } from "@t3tools/shared/meshLayout";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const entryJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const keyPattern =
  /^(?:ws\.(?:default|quietAfterDays)|(?:ws|rule|order|alias|proj|machine|workspaceOrder|legacy)\/[^/]+|(?:place|fold|rep|repstatus|empty)\/[^/]+\/[^/]+)$/;
export const validateEntries = Effect.fn("MeshLayout.validateEntries")(function* (
  entries: MeshLayoutDocument,
) {
  const invalid = yield* Effect.try({
    try: () =>
      Object.keys(entries).length > 5000 ||
      Object.entries(entries).some(([key, entry]) => {
        if (!keyPattern.test(key) || !/^\d{13}\.\d{5}\..+$/.test(entry.h)) return true;
        for (const part of key.split("/")) decodeURIComponent(part);
        return new TextEncoder().encode(entryJson({ [key]: entry })).byteLength > 65536;
      }),
    catch: (cause) =>
      new MeshLayoutError({ reason: "invalid_entries", message: "Invalid mesh entries", cause }),
  });
  if (invalid)
    return yield* new MeshLayoutError({
      reason: "invalid_entries",
      message: "Invalid mesh key, clock, entry size or batch size",
    });
});
