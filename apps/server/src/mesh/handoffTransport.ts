import { ChatAttachment, HandoffBundle, ThreadMoveResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const ReceiveHandoffInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("prepare"),
    handoffId: Schema.String,
    projectId: Schema.String,
    logicalKey: Schema.optional(Schema.String),
  }),
  Schema.Struct({ action: Schema.Literal("receive"), bundle: HandoffBundle }),
  Schema.Struct({
    action: Schema.Literal("undo"),
    handoffId: Schema.String,
    threadId: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("followup"),
    handoffId: Schema.String,
    threadId: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("upload"),
    handoffId: Schema.String,
    attachment: ChatAttachment,
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    data: Schema.String.check(Schema.isMaxLength(750_000)),
    final: Schema.Boolean,
  }),
]);
export type ReceiveHandoffInput = typeof ReceiveHandoffInput.Type;
export const ReceiveHandoffResult = Schema.Union([
  Schema.Struct({ project: Schema.Struct({ logicalKey: Schema.String, title: Schema.String }) }),
  ThreadMoveResult,
  Schema.Struct({ attachment: Schema.NullOr(ChatAttachment) }),
  Schema.Struct({ ok: Schema.Boolean }),
]);
