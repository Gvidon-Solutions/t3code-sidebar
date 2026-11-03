import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { CommandId, EnvironmentId, ThreadId, ProjectId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestratorMcpFailure } from "./orchestratorMcp.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
export * from "./threadHandoffData.ts";
export const ThreadMoveInput = Schema.Struct({
  commandId: Schema.optional(CommandId),
  threadId: ThreadId,
  projectId: Schema.optional(ProjectId),
  targetEnvironmentId: Schema.optional(EnvironmentId),
  logicalKey: Schema.optional(Schema.String),
  modelSelection: Schema.optional(ModelSelection),
  message: Schema.optional(Schema.String),
  undoHandoffId: Schema.optional(Schema.String),
});
export type ThreadMoveInput = typeof ThreadMoveInput.Type;
export const ThreadMoveResult = Schema.Struct({
  threadId: ThreadId,
  environmentId: EnvironmentId,
  handoffId: Schema.NullOr(Schema.String),
  undoUntil: Schema.Number,
  link: Schema.String,
  machine: Schema.String,
});
export type ThreadMoveResult = typeof ThreadMoveResult.Type;
export const ThreadMoveRpc = Rpc.make("threads.move", {
  payload: ThreadMoveInput,
  success: ThreadMoveResult,
  error: Schema.Union([OrchestratorMcpFailure, EnvironmentAuthorizationError]),
});
