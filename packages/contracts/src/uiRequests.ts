/**
 * Fork: agents (and the voice, through its Codex thread) asking the owner's
 * clients to show something. A request belongs to the asking thread; each
 * client decides on its own whether it applies (see client-runtime uiRequests).
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

export const UI_REQUESTS_WS_METHODS = {
  subscribe: "uiRequests.subscribe",
} as const;

/** Requests from now on; nothing is replayed to a client that connects later. */
export const WsUiRequestsSubscribeRpc = Rpc.make(UI_REQUESTS_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: UiRequest,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const UI_REQUESTS_RPCS = [WsUiRequestsSubscribeRpc] as const;
