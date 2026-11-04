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
  projectId: ProjectId,
  modelSelection: Schema.optional(ModelSelection),
});
export type ThreadMoveInput = typeof ThreadMoveInput.Type;
export const ThreadMoveResult = Schema.Struct({
  threadId: ThreadId,
  environmentId: EnvironmentId,
  link: Schema.String,
  machine: Schema.String,
});
export type ThreadMoveResult = typeof ThreadMoveResult.Type;
export const ThreadMoveRpc = Rpc.make("threads.move", {
  payload: ThreadMoveInput,
  success: ThreadMoveResult,
  error: Schema.Union([OrchestratorMcpFailure, EnvironmentAuthorizationError]),
});
