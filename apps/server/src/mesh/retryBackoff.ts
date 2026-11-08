import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export const meshRetryDelay = (
  attempt: number,
  random = 1,
  limits = { initialMs: 1000, maxMs: 15000 },
) =>
  Math.max(
    limits.initialMs,
    Math.min(limits.maxMs, limits.initialMs * 2 ** Math.min(30, Math.max(0, attempt))) *
      (0.8 + Math.min(1, Math.max(0, random)) * 0.2),
  );

export const meshRetrySchedule = Schedule.spaced("1 second").pipe(
  Schedule.modifyDelay(({ attempt }) => Effect.succeed(meshRetryDelay(attempt - 1))),
);
