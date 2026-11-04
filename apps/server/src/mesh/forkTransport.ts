import {
  ChatAttachment,
  ForkBundle,
  ProjectId,
  ThreadForkResult,
  ModelSelection,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const ForkTransportInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("flush"),
    forkId: Schema.String,
    logicalKey: Schema.String,
    environmentId: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("prepare"),
    forkId: Schema.String,
    projectId: Schema.optional(ProjectId),
    logicalKey: Schema.optional(Schema.String),
    modelSelection: Schema.optional(ModelSelection),
  }),
  Schema.Struct({ action: Schema.Literal("receive"), bundle: ForkBundle }),
  Schema.Struct({
    action: Schema.Literal("rollback"),
    forkId: Schema.String,
    threadId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("upload"),
    forkId: Schema.String,
    attachment: ChatAttachment,
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    data: Schema.String.check(Schema.isMaxLength(750_000)),
    final: Schema.Boolean,
  }),
]);
export type ForkTransportInput = typeof ForkTransportInput.Type;

export const ForkPrepareResult = Schema.Struct({
  projectId: ProjectId,
  logicalKey: Schema.String,
  title: Schema.String,
  machine: Schema.String,
  placed: Schema.Boolean,
});
export type ForkPrepareResult = typeof ForkPrepareResult.Type;

export const ForkTransportResult = Schema.Union([
  ForkPrepareResult,
  ThreadForkResult,
  Schema.Struct({ attachment: Schema.NullOr(ChatAttachment) }),
  Schema.Struct({ ok: Schema.Boolean }),
]);
