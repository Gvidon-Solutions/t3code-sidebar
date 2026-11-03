import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
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
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  entries: Schema.Array(HandoffEntry),
});
export type HandoffBundle = typeof HandoffBundle.Type;
