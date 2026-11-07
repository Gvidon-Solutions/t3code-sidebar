import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DELIVERY_UPDATING = "T3_UPDATING";
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
    if (
      "message" in current &&
      typeof current.message === "string" &&
      current.message.includes(DELIVERY_UPDATING)
    )
      return true;
    current = "cause" in current ? current.cause : null;
  }
  return false;
}
