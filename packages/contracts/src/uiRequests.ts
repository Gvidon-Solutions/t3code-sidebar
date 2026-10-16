/**
 * Fork: agents (and the voice, through its Codex thread) asking the owner's
 * clients to show something, or to end, mute or move the thread's voice
 * conversation. A request belongs to the asking thread; each client decides
 * on its own whether it applies (see client-runtime uiRequests).
 */
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const UiOpenTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread"),
    threadId: ThreadId,
  }),
  Schema.Struct({
    kind: Schema.Literal("inbox"),
    issueId: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    /** Relative to the asking thread's workspace. */
    path: TrimmedNonEmptyString,
    line: Schema.optional(PositiveInt),
  }),
  Schema.Struct({
    kind: Schema.Literal("diff"),
  }),
  Schema.Struct({
    kind: Schema.Literal("workspace"),
    /** A sidebar workspace's name or id. */
    workspace: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("home"),
  }),
]);
export type UiOpenTarget = typeof UiOpenTarget.Type;

export const UiOpenInput = Schema.Struct({
  target: UiOpenTarget,
});
export type UiOpenInput = typeof UiOpenInput.Type;

export const UiOpenResult = Schema.Struct({
  /** Clients connected to receive it; 0 means nobody is looking. */
  clients: Schema.Int,
});
export type UiOpenResult = typeof UiOpenResult.Type;

export const UiRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** The thread whose agent asked. */
  threadId: ThreadId,
  target: UiOpenTarget,
});
export type UiRequest = typeof UiRequest.Type;

/**
 * What the device holding a thread's voice conversation does on the owner's
 * spoken request: hang up, turn its microphone off (the owner turns it back
 * on with the button), or carry the conversation over to another thread.
 */
export const VoiceCommandAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("end") }),
  Schema.Struct({ type: Schema.Literal("mute") }),
  Schema.Struct({ type: Schema.Literal("move"), threadId: ThreadId }),
]);
export type VoiceCommandAction = typeof VoiceCommandAction.Type;

export const VoiceCommand = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** The thread whose voice conversation it is. */
  threadId: ThreadId,
  action: VoiceCommandAction,
});
export type VoiceCommand = typeof VoiceCommand.Type;

export const VoiceControlInput = Schema.Struct({
  action: Schema.Literals(["end", "mute"]),
});
export type VoiceControlInput = typeof VoiceControlInput.Type;

export const VoiceMoveInput = Schema.Struct({
  /** The thread to continue the conversation in, on this environment. */
  threadId: ThreadId,
});
export type VoiceMoveInput = typeof VoiceMoveInput.Type;

export const VoiceCommandResult = Schema.Struct({
  /** Clients connected to receive it; the one holding the conversation acts. */
  clients: Schema.Int,
});
export type VoiceCommandResult = typeof VoiceCommandResult.Type;

export const UI_REQUESTS_WS_METHODS = {
  subscribe: "uiRequests.subscribe",
  subscribeVoiceCommands: "uiRequests.subscribeVoiceCommands",
} as const;

/** Requests from now on; nothing is replayed to a client that connects later. */
export const WsUiRequestsSubscribeRpc = Rpc.make(UI_REQUESTS_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: UiRequest,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/** Voice commands from now on, apart from `ui_open` so older clients never see them. */
export const WsUiRequestsSubscribeVoiceCommandsRpc = Rpc.make(
  UI_REQUESTS_WS_METHODS.subscribeVoiceCommands,
  {
    payload: Schema.Struct({}),
    success: VoiceCommand,
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);

export const UI_REQUESTS_RPCS = [
  WsUiRequestsSubscribeRpc,
  WsUiRequestsSubscribeVoiceCommandsRpc,
] as const;
