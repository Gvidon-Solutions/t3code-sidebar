import { expect, it } from "vite-plus/test";
import { workerPolicy } from "./RunWorkerPolicy.ts";
const policy = workerPolicy();
it("defaults to ten seconds of termination grace and validates explicit settings", () => {
  expect(policy.killGraceMs(undefined)).toBe(10_000);
  expect(policy.killGraceMs("25000")).toBe(25_000);
  expect(policy.killGraceMs(0)).toBe(0);
  for (const value of [-1, NaN, Infinity, "", "wrong", false, 2147483648])
    expect(() => policy.killGraceMs(value)).toThrow();
  expect(policy.jobRetentionMs(undefined)).toBe(7 * 24 * 60 * 60 * 1000);
  expect(policy.jobLogBytes(undefined)).toBe(10 * 1024 * 1024);
  expect(() => policy.jobLogBytes(1)).toThrow();
});
