import * as Effect from "effect/Effect";

import * as UiRequests from "../../../uiRequests/UiRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { UiToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(UiToolkit, {
  // A request belongs to the calling thread: clients act on it only where that
  // thread is in front of the user.
  ui_open: McpToolAccess.actsAsCaller(({ target }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "ui_open");
      const uiRequests = yield* UiRequests.UiRequests;
      const clients = yield* uiRequests.open({ threadId: thread.threadId, target });
      return { clients };
    }),
  ),
});
