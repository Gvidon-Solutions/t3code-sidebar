import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as VoiceSessionService from "../../../orchestration-v2/VoiceSessionService.ts";
import * as UiRequests from "../../../uiRequests/UiRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { UiToolkit } from "./tools.ts";

/** The calling thread, which must hold a live voice conversation. */
const requireLiveVoice = Effect.fn("UiToolkit.requireLiveVoice")(function* (operation: string) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, operation);
  const voiceSessions = yield* VoiceSessionService.VoiceSessionServiceV2;
  if (!(yield* voiceSessions.isLive(thread.threadId))) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "No voice conversation is live in this thread.",
    });
  }
  return thread.threadId;
});

const readLiveThread = Effect.fn("UiToolkit.readLiveThread")(function* (threadId: ThreadId) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
  if (shell === null || shell.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The thread was not found.",
    });
  }
  return shell;
});

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
  // Only the device holding this thread's voice conversation acts on these.
  voice_control: McpToolAccess.actsAsCaller(({ action }) =>
    Effect.gen(function* () {
      const threadId = yield* requireLiveVoice("voice_control");
      const uiRequests = yield* UiRequests.UiRequests;
      const clients = yield* uiRequests.voice({ threadId, action: { type: action } });
      return { clients };
    }),
  ),
  voice_move: McpToolAccess.actsAsCaller(({ threadId: targetId }) =>
    Effect.gen(function* () {
      const threadId = yield* requireLiveVoice("voice_move");
      if (targetId === threadId) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The conversation is already in this thread.",
        });
      }
      const [from] = yield* Effect.all([readLiveThread(threadId), readLiveThread(targetId)]);
      const voiceSessions = yield* VoiceSessionService.VoiceSessionServiceV2;
      // The device calls the target right away, so a fresh thread must be ready first.
      if (!(yield* voiceSessions.whenReady(targetId))) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The target thread is still preparing; try again in a moment.",
        });
      }
      yield* voiceSessions.carryOver({ from: threadId, fromTitle: from.title, to: targetId });
      const uiRequests = yield* UiRequests.UiRequests;
      const clients = yield* uiRequests.voice({
        threadId,
        action: { type: "move", threadId: targetId },
      });
      return { clients };
    }),
  ),
});
