// @effect-diagnostics nodeBuiltinImport:off -- Evaluate the same plain JavaScript policy embedded in remote supervisors.
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";
import { RUN_WORKER_POLICY_SOURCE } from "./RunWorkerPolicy.ts";
const policy = NodeVM.runInNewContext(
  `${RUN_WORKER_POLICY_SOURCE}; ({killGraceMs,jobRetentionMs,jobLogBytes})`,
) as Record<string, (value?: unknown) => number>;
it("defaults to ten seconds of termination grace and validates explicit settings", () => {
  expect(policy.killGraceMs!()).toBe(10_000);
  expect(policy.killGraceMs!("25000")).toBe(25_000);
  expect(policy.killGraceMs!(0)).toBe(0);
  for (const value of [-1, NaN, Infinity, "", "wrong", false, 2147483648])
    expect(() => policy.killGraceMs!(value)).toThrow();
  expect(policy.jobRetentionMs!()).toBe(7 * 24 * 60 * 60 * 1000);
  expect(policy.jobLogBytes!()).toBe(10 * 1024 * 1024);
  expect(() => policy.jobLogBytes!(1)).toThrow();
});
