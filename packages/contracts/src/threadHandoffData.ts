import * as Schema from "effect/Schema";
import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MeshForkOrigin = Schema.Struct({
  id: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  machine: Schema.String,
  link: Schema.String,
  createdAt: IsoDateTime,
});
export type MeshForkOrigin = typeof MeshForkOrigin.Type;

export const MeshForkRef = Schema.Struct({
  id: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  machine: Schema.String,
  link: Schema.String,
  createdAt: IsoDateTime,
});
export type MeshForkRef = typeof MeshForkRef.Type;
import { ChatAttachment } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";

export const HandoffEntry = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
});
export type HandoffEntry = typeof HandoffEntry.Type;
export const ThreadHandoffState = Schema.Struct({
  id: TrimmedNonEmptyString,
  phase: Schema.Literals(["preparing", "received", "completed", "undone", "retracted"]),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  link: Schema.String,
  tag: Schema.String,
  undoUntil: Schema.Number,
});
export type ThreadHandoffState = typeof ThreadHandoffState.Type;
export const HandoffBundle = Schema.Struct({
  id: TrimmedNonEmptyString,
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  sourceTag: Schema.String,
  sourceLink: Schema.String,
  date: Schema.String,
  logicalKey: Schema.String,
  projectTitle: Schema.String,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  modelSelectionExplicit: Schema.optional(Schema.Boolean),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  entries: Schema.Array(HandoffEntry),
});
export type HandoffBundle = typeof HandoffBundle.Type;
