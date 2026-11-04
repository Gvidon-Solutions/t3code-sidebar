import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { MeshConfigError } from "./meshConfig.ts";

it("round trips stale revision errors with added, removed and changed config fields over JSON", () => {
  const codec = Schema.fromJsonString(MeshConfigError);
  const error = new MeshConfigError({
    reason: "stale_revision",
    message: "Config changed",
    diff: [
      { path: "$.added", before: undefined, after: "value" },
      { path: "$.removed", before: null, after: undefined },
      { path: "$.changed", before: "old", after: "new" },
    ],
  });
  const encoded = Schema.encodeSync(codec)(error);
  expect(Schema.decodeSync(codec)(encoded).diff).toEqual([
    { path: "$.added", after: "value" },
    { path: "$.removed", before: null },
    { path: "$.changed", before: "old", after: "new" },
  ]);
});
