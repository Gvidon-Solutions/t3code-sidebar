import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as Effect from "effect/Effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export class DeliveryUpdatingError extends Schema.TaggedError<DeliveryUpdatingError>()(
  "DeliveryUpdatingError",
  {
    message: Schema.String.pipe(
      Schema.withConstructorDefault(Effect.succeed("Server is updating; retry this command")),
    ),
  },
) {}

export const ADMISSION_GATED_EFFECT_TYPES = [
  "provider-turn.start",
  "provider-turn.restart",
] as const;
export const DeliveryDrainInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  now: Schema.optionalKey(Schema.Boolean),
  deadlineMs: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 3600000 }),
  ),
});
export const DeliveryDrainToken = Schema.Struct({ requestId: TrimmedNonEmptyString });
export const DeliveryDrainStatus = Schema.Struct({
  requestId: Schema.NullOr(Schema.String),
  phase: Schema.Literals(["open", "draining", "drained"]),
  deadlineAt: Schema.NullOr(Schema.Number),
  activeRuns: Schema.Number,
  pendingStarts: Schema.Number,
});
export class DeliveryDrainError extends Schema.TaggedError<DeliveryDrainError>()(
  "DeliveryDrainError",
  {
    message: Schema.String,
  },
) {}
export const DeliveryRpcs = [
  Rpc.make("delivery.drain", {
    payload: DeliveryDrainInput,
    success: DeliveryDrainStatus,
    error: DeliveryDrainError,
  }),
  Rpc.make("delivery.drainStatus", { success: DeliveryDrainStatus, error: DeliveryDrainError }),
  Rpc.make("delivery.cancelDrain", {
    payload: DeliveryDrainToken,
    success: DeliveryDrainStatus,
    error: DeliveryDrainError,
  }),
] as const;

export function isDeliveryUpdating(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("_tag" in current && current._tag === "DeliveryUpdatingError") return true;
    current = "cause" in current ? current.cause : null;
  }
  return false;
}
