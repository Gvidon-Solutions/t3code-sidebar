import { type InboxError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as InboxService from "../../../inbox/InboxService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { InboxToolkit } from "./tools.ts";

// Inbox errors are written for the agent: an unknown id, a closed issue.
const toFailure = (error: InboxError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const caller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.map((scope): InboxService.InboxCaller => ({
    threadId: scope.thread?.threadId ?? null,
    clientLabel: scope.client?.label ?? null,
  })),
);

export const layer = McpToolAccess.toLayer(InboxToolkit, {
  inbox_post: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const inbox = yield* InboxService.InboxService;
      return yield* inbox.post(yield* caller, input).pipe(Effect.mapError(toFailure));
    }),
  ),
  inbox_get: McpToolAccess.reads(({ issueId }) =>
    InboxService.InboxService.pipe(
      Effect.flatMap((inbox) => inbox.get(issueId)),
      Effect.mapError(toFailure),
    ),
  ),
  inbox_list: McpToolAccess.reads((input) =>
    InboxService.InboxService.pipe(
      Effect.flatMap((inbox) => inbox.list(input)),
      Effect.map((issues) => ({ issues })),
      Effect.mapError(toFailure),
    ),
  ),
  inbox_comment: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const inbox = yield* InboxService.InboxService;
      return yield* inbox.agentComment(yield* caller, input).pipe(Effect.mapError(toFailure));
    }),
  ),
  inbox_update: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const inbox = yield* InboxService.InboxService;
      return yield* inbox.update(yield* caller, input).pipe(Effect.mapError(toFailure));
    }),
  ),
  inbox_resolve: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const inbox = yield* InboxService.InboxService;
      return yield* inbox.resolve(yield* caller, input).pipe(Effect.mapError(toFailure));
    }),
  ),
});
