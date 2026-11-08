import { expect, it } from "vitest";
import { missingBarrierEntries } from "./convergence.ts";

it("accepts fully collected tombstones while rejecting missing writes, stale resurrection and divergent equal clocks", () => {
  const old = { v: "old", h: "0000000000001.00000.studio" };
  const deleted = { v: null, h: "0000000000002.00000.studio" };
  const newer = { v: "new", h: "0000000000003.00000.studio" };
  expect(missingBarrierEntries({ key: deleted }, [{}, {}])).toEqual([[], []]);
  expect(
    missingBarrierEntries({ key: old }, [{}, {}]).every((missing) => missing.length === 1),
  ).toBe(true);
  expect(
    missingBarrierEntries({ key: deleted }, [{}, { key: old }]).every(
      (missing) => missing.length === 1,
    ),
  ).toBe(true);
  expect(missingBarrierEntries({ key: old }, [{ key: newer }, { key: newer }])).toEqual([[], []]);
  expect(
    missingBarrierEntries({ key: old }, [{ key: { ...old, v: "different" } }])[0],
  ).toHaveLength(1);
});
