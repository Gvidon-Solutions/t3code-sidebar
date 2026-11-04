import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { MeshConfigDocument, MeshConfigError } from "./meshConfig.ts";

it("validates configurable replica command names while retaining future replica fields", () => {
  const decode = Schema.decodeUnknownSync(MeshConfigDocument);
  expect(
    decode({
      schema: 1,
      machines: {},
      replicas: { remoteCommands: ["git", "my-builder"], future: true },
    }).replicas,
  ).toEqual({ remoteCommands: ["git", "my-builder"], future: true });
  for (const remoteCommands of [["../git"], ["git status"], [""], [42], "git"]) {
    expect(() => decode({ schema: 1, machines: {}, replicas: { remoteCommands } })).toThrow();
  }
  expect(
    decode({ schema: 1, machines: {}, replicas: { remoteCommands: [] } }).replicas?.remoteCommands,
  ).toEqual([]);
});

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
