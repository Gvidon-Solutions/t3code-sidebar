import { expect, it } from "vite-plus/test";
import {
  READ_FAILURE_THRESHOLD,
  readProgress,
  rolloutDecision,
  rolloutTimeoutMessage,
  type RolloutObservation,
} from "./rollout-outcome.ts";

const expected = { targetVersion: "0.1.6", secondVersion: "0.1.5" };
const first = (state: RolloutObservation["state"]): RolloutObservation => ({
  name: "cloudbox",
  role: "first",
  state,
});
const second = (state: RolloutObservation["state"]): RolloutObservation => ({
  name: "laptop",
  role: "second",
  state,
});

it("fails on a first-machine rollback instead of waiting for the second machine", () => {
  const decision = rolloutDecision(
    [
      first({
        activeVersion: "0.1.5",
        update: { status: "rolled-back", reason: "Replicas have not resumed" },
      }),
      second({ activeVersion: "0.1.5" }),
    ],
    expected,
  );
  expect(decision).toMatchObject({ status: "failed", node: "cloudbox", role: "first" });
  expect(JSON.stringify(decision)).toContain("Replicas have not resumed");
  expect(JSON.stringify(decision)).toContain("activeVersion=0.1.5");
});

it("fails on a first-machine rollback even before the second state exists", () => {
  expect(
    rolloutDecision(
      [
        first({
          activeVersion: "0.1.5",
          update: { status: "rolled-back", reason: "replica health failed" },
        }),
        { name: "laptop", role: "second" },
      ],
      expected,
    ),
  ).toMatchObject({ status: "failed", node: "cloudbox", role: "first" });
});

it("does not accept a second-machine rollback while the first machine has not committed", () => {
  expect(
    rolloutDecision(
      [
        first({ activeVersion: "0.1.5" }),
        second({ activeVersion: "0.1.5", update: { status: "rolled-back" } }),
      ],
      expected,
    ),
  ).toEqual({ status: "pending" });
});

it("accepts only the committed first machine and deliberately rolled-back second machine", () => {
  expect(
    rolloutDecision(
      [
        first({ activeVersion: "0.1.6", update: { status: "committed" } }),
        second({ activeVersion: "0.1.5", update: { status: "rolled-back" } }),
      ],
      expected,
    ),
  ).toMatchObject({ status: "expected" });
});

it("does not accept a second-machine failure as the deliberate rollback", () => {
  const decision = rolloutDecision(
    [
      first({ activeVersion: "0.1.6", update: { status: "committed" } }),
      second({
        activeVersion: "0.1.5",
        update: { status: "failed", reason: "Health check crashed" },
      }),
    ],
    expected,
  );
  expect(decision).toMatchObject({ status: "failed", node: "laptop", role: "second" });
  expect(JSON.stringify(decision)).toContain("Health check crashed");
});

it("fails when the second machine commits despite the deliberate health failure", () => {
  expect(
    rolloutDecision(
      [first({ activeVersion: "0.1.6" }), second({ activeVersion: "0.1.6" })],
      expected,
    ),
  ).toMatchObject({ status: "failed", node: "laptop", role: "second" });
});

it("fails when a required service state cannot be read", () => {
  expect(
    rolloutDecision(
      [
        { name: "cloudbox", role: "first", error: "invalid JSON" },
        second({ activeVersion: "0.1.5" }),
      ],
      expected,
    ),
  ).toMatchObject({ status: "failed", node: "cloudbox", role: "first" });
});

it("tolerates partial JSON until a valid read resets the streak", () => {
  const partial = { error: "Unexpected end of JSON input" };
  let progress = readProgress({ failures: 0 }, partial);
  expect(progress).toMatchObject({ failures: 1, pending: true });
  progress = readProgress(progress, partial);
  expect(progress).toMatchObject({ failures: 2, pending: true });
  progress = readProgress(progress, { state: { activeVersion: "0.1.5" } });
  expect(progress).toMatchObject({ failures: 0, pending: true });
  progress = readProgress(progress, partial);
  progress = readProgress(progress, partial);
  expect(progress).toMatchObject({ failures: 2, pending: true });
});

it("gives up when transient read failures reach the threshold", () => {
  let progress = { failures: 0, pending: true };
  for (let attempt = 1; attempt < READ_FAILURE_THRESHOLD; attempt++) {
    progress = readProgress(progress, { error: "docker exec transient" });
    expect(progress.pending).toBe(true);
  }
  progress = readProgress(progress, { error: "docker exec transient" });
  expect(progress).toMatchObject({ pending: false, error: "docker exec transient" });
});

it("fails fast on a classified permission error", () => {
  expect(
    readProgress({ failures: 0 }, { error: "EACCES: permission denied", permanent: true }),
  ).toMatchObject({ pending: false, error: "EACCES: permission denied" });
});

it("keeps a missing state pending without counting failures", () => {
  expect(readProgress({ failures: 2 }, { missing: true })).toMatchObject({
    failures: 0,
    pending: true,
  });
});

it("keeps a first-machine rollback terminal while reads are recovering", () => {
  const decision = rolloutDecision(
    [
      first({
        activeVersion: "0.1.5",
        update: { status: "rolled-back", reason: "replica health failed" },
      }),
      second({ activeVersion: "0.1.5" }),
    ],
    expected,
  );
  expect(decision).toMatchObject({ status: "failed", node: "cloudbox", role: "first" });
});

it("includes the last read cause in the timeout diagnostic", () => {
  const message = rolloutTimeoutMessage(
    { status: "pending" },
    [first({ activeVersion: "0.1.5" }), { name: "laptop", role: "second" }],
    { cloudbox: "Unexpected end of JSON input", laptop: undefined },
    120_000,
  );
  expect(message).toContain("120000ms");
  expect(message).toContain("Unexpected end of JSON input");
  expect(message).toContain("cloudbox");
  expect(message).toContain('"activeVersion":"0.1.5"');
});
