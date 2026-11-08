import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { backoffDelay, meshRetryDelay, meshRetrySchedule } from "./Backoff.ts";
it.effect(
  "shares the bounded one-to-fifteen-second backoff between timers and Effect retries",
  () =>
    Effect.gen(function* () {
      const step = yield* Schedule.toStep(meshRetrySchedule());
      for (const attempt of [0, 1, 2, 3, 4, 5, 6]) {
        const [, delay] = yield* step(attempt * 20_000, undefined);
        expect(Duration.toMillis(delay)).toBe(meshRetryDelay(attempt));
        for (const random of [-1, 0, 0.5, 1, 2]) {
          expect(meshRetryDelay(attempt, random)).toBeGreaterThanOrEqual(1000);
          expect(meshRetryDelay(attempt, random)).toBeLessThanOrEqual(15_000);
        }
      }
    }),
);

it("makes jitter and scaling explicit while preserving the retry cap", () => {
  const limits = { initialMs: 1000, maxMs: 15000, jitter: 0.5 };
  expect(backoffDelay(4, { ...limits, random: 0 })).toBe(7500);
  expect(backoffDelay(4, { ...limits, random: 1 })).toBe(15000);
  expect(backoffDelay(4, { ...limits, jitter: 0, random: 0 })).toBe(15000);
  expect(backoffDelay(4, { ...limits, random: 0, scale: 0.01 })).toBe(75);
});
