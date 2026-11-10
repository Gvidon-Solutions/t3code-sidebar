import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { MeshConfigDocument, MeshConfigError } from "./meshConfig.ts";
import { ReplicaLiveStatus } from "./meshLayout.ts";
import { SidebarMachineReported } from "./sidebarWorkspaces.ts";

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

const decodeReplica = Schema.decodeUnknownSync(ReplicaLiveStatus);
const decodeReported = Schema.decodeUnknownSync(SidebarMachineReported);
it("preserves optional replica lag and SSH route checks and accepts older reports", () => {
  const replica = {
    logicalKey: "notes",
    environmentId: "cloudbox",
    state: "watching",
    conflicts: [],
    problems: [],
    updatedAt: "2026-11-05T00:00:00Z",
  };
  expect(decodeReplica(replica).lag).toBeUndefined();
  expect(
    decodeReplica({
      ...replica,
      lag: { filesBehind: 2, bytesBehind: 64 },
    }).lag,
  ).toEqual({ filesBehind: 2, bytesBehind: 64 });
  const reported = {
    version: "1.5",
    user: null,
    sshd: null,
    platform: { os: "linux", arch: "x64", release: "test" },
    reportedAt: "2026-11-05T00:00:00Z",
  };
  expect(decodeReported(reported).sshRoutes).toBeUndefined();
  const sshRoutes = {
    studio: { status: "failed", reason: "Host key changed", checkedAt: "2026-11-05T00:00:00Z" },
  };
  expect(decodeReported({ ...reported, sshRoutes }).sshRoutes).toEqual(sshRoutes);
});

it("validates rollout drain controls and forwards unknown policy fields", () => {
  const decode = Schema.decodeUnknownSync(MeshConfigDocument);
  const t3 = {
    version: "0.1.6",
    future: true,
    drain: { maxWaitMs: 120000, skipForVersion: "0.1.6", newerPolicy: { enabled: true } },
  };
  expect(decode({ schema: 1, machines: {}, t3 }).t3).toEqual(t3);
  for (const maxWaitMs of [0, -1, 0.5, 3600001, "1000"])
    expect(() => decode({ schema: 1, machines: {}, t3: { drain: { maxWaitMs } } })).toThrow();
});

it("accepts the optional machine tag appearance and rejects unknown values with a plain reason", () => {
  const decode = Schema.decodeUnknownSync(MeshConfigDocument);
  expect(
    decode({
      schema: 1,
      machines: {},
      appearance: { machineTags: { style: "solid", textColor: "neutral" }, future: true },
    }).appearance,
  ).toEqual({ machineTags: { style: "solid", textColor: "neutral" }, future: true });
  expect(decode({ schema: 1, machines: {} }).appearance).toBeUndefined();
  for (const style of ["rainbow", 1, null])
    expect(() =>
      decode({ schema: 1, machines: {}, appearance: { machineTags: { style } } }),
    ).toThrow(/tinted|solid|outline/);
  for (const textColor of ["white", true])
    expect(() =>
      decode({ schema: 1, machines: {}, appearance: { machineTags: { textColor } } }),
    ).toThrow(/machine|neutral/);
});
