import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestratorMcpFailure } from "./orchestratorMcp.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { HandoffEntry, MeshForkOrigin, MeshForkRef } from "./threadHandoffData.ts";
export { MeshForkOrigin, MeshForkRef };
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ServerProvider } from "./server.ts";

export const ThreadForkCatalog = Schema.Struct({
  providers: Schema.Array(ServerProvider),
});
export type ThreadForkCatalog = typeof ThreadForkCatalog.Type;

export const ThreadForkCatalogRpc = Rpc.make("threads.forkCatalog", {
  payload: Schema.Struct({ targetEnvironmentId: EnvironmentId }),
  success: ThreadForkCatalog,
  error: Schema.Union([OrchestratorMcpFailure, EnvironmentAuthorizationError]),
});

export const ThreadForkInput = Schema.Struct({
  commandId: Schema.optional(CommandId),
  threadId: ThreadId,
  targetEnvironmentId: EnvironmentId,
  projectId: Schema.optional(ProjectId),
  logicalKey: Schema.optional(Schema.String),
  modelSelection: Schema.optional(ModelSelection),
  title: Schema.optional(TrimmedNonEmptyString),
  message: Schema.optional(Schema.String),
});
export type ThreadForkInput = typeof ThreadForkInput.Type;

export const ThreadForkResult = Schema.Struct({
  threadId: ThreadId,
  environmentId: EnvironmentId,
  link: Schema.String,
  machine: Schema.String,
  title: TrimmedNonEmptyString,
});
export type ThreadForkResult = typeof ThreadForkResult.Type;

export const ThreadForkRpc = Rpc.make("threads.fork", {
  payload: ThreadForkInput,
  success: ThreadForkResult,
  error: Schema.Union([OrchestratorMcpFailure, EnvironmentAuthorizationError]),
});

/** Target-side data a source machine copies into a new thread. */
export const ForkBundle = Schema.Struct({
  id: TrimmedNonEmptyString,
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  sourceTitle: TrimmedNonEmptyString,
  sourceMachine: Schema.String,
  sourceLink: Schema.String,
  logicalKey: Schema.String,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  entries: Schema.Array(HandoffEntry),
  message: Schema.optional(Schema.String),
});
export type ForkBundle = typeof ForkBundle.Type;
