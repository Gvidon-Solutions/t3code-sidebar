import { expect, it } from "vite-plus/test";
import { rolloutDecision, type RolloutObservation } from "./rollout-outcome.ts";

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
