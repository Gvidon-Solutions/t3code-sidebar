import { expect, it } from "vite-plus/test";
import { captureBarrier, hasReachedBarrier } from "./convergence.ts";

it("requires every captured entry and tombstone on every observer while live reports advance", () => {
  const old = { v: { state: "pending" }, h: "0000000000001.00000.studio" };
  const done = { v: { state: "done" }, h: "0000000000002.00000.studio" };
  const removed = { v: null, h: "0000000000003.00000.laptop" };
  const barrier = captureBarrier([{ status: old, removed }, { status: done }]);
  expect(barrier).toEqual({ status: done, removed });
  expect(hasReachedBarrier(barrier, { status: done, removed })).toBe(true);
  expect(hasReachedBarrier(barrier, { status: done })).toBe(false);
  expect(hasReachedBarrier(barrier, { status: old, removed })).toBe(false);
  expect(hasReachedBarrier(barrier, { status: done, removed: { ...removed, v: true } })).toBe(
    false,
  );
  expect(
    hasReachedBarrier(barrier, {
      status: { v: { state: "watching" }, h: "0000000000004.00000.studio" },
      removed,
    }),
  ).toBe(true);
});
