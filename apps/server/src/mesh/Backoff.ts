import * as Random from "effect/Random";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { meshMillis } from "./MeshTiming.ts";

export const backoffDelay = (
  attempt: number,
  options: { initialMs: number; maxMs: number; jitter: number; random: number; scale?: number },
) =>
  meshMillis(
    Math.max(
      options.initialMs,
      Math.min(options.maxMs, options.initialMs * 2 ** Math.min(30, Math.max(0, attempt))) *
        (1 - options.jitter + Math.min(1, Math.max(0, options.random)) * options.jitter),
    ),
    options.scale ?? 1,
  );

export const backoffSchedule = (options: {
  initialMs: number;
  maxMs: number;
  jitter: number;
  scale?: number;
}) =>
  Schedule.spaced(meshMillis(options.initialMs, options.scale)).pipe(
    Schedule.modifyDelay(({ attempt }) =>
      Effect.map(Random.next, (random) => backoffDelay(attempt - 1, { ...options, random })),
    ),
  );

export const meshRetryDelay = (
  attempt: number,
  random = 1,
  limits = { initialMs: 1000, maxMs: 15000 },
  scale = 1,
) => backoffDelay(attempt, { ...limits, random, jitter: 0.2, scale });

export const meshRetrySchedule = (scale = 1) =>
  Schedule.spaced(meshMillis(1000, scale)).pipe(
    Schedule.modifyDelay(({ attempt }) =>
      Effect.succeed(meshRetryDelay(attempt - 1, 1, undefined, scale)),
    ),
  );
