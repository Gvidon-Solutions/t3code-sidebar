import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { runThreadFork } from "@t3tools/client-runtime/state/thread-forks";
import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useThreadActions } from "../../hooks/useThreadActions";
import { newThreadId } from "../../lib/utils";
import { readThreadShell, readThreadShells, waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";

/**
 * Forks a thread (sidebar fork): "Title (n)", placed right under the source
 * in its project, then opened. Without `runId` it forks from the latest
 * completed response. Resolves to an error message, or null when done or
 * cancelled.
 */
export function useForkThread() {
  const navigate = useNavigate();
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, { reportFailure: false });
  const { reorderActiveThread } = useThreadActions();

  return async (source: ScopedThreadRef, runId?: RunId): Promise<string | null> => {
    const outcome = await runThreadFork(source, runId, {
      readThread: (target) => readThreadShell(target),
      threadsInEnvironment: (environmentId) =>
        readThreadShells().filter((thread) => thread.environmentId === environmentId),
      createThreadId: newThreadId,
      fork: async (input) => {
        const result = await forkFromRun({ environmentId: source.environmentId, input });
        if (result._tag === "Success") return { ok: true };
        if (isAtomCommandInterrupted(result)) {
          return { ok: false, interrupted: true, message: "" };
        }
        const error = squashAtomCommandFailure(result);
        return {
          ok: false,
          interrupted: false,
          message: error instanceof Error ? error.message : "Failed to fork this thread.",
        };
      },
      waitForThread: (target) => waitForThreadShell(target),
      reorder: (target, orderKey) => reorderActiveThread(target, orderKey),
      now: () => new Date().toISOString(),
    });
    switch (outcome.kind) {
      case "forked":
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(outcome.target),
        });
        return null;
      case "source-missing":
        return "This thread is no longer available.";
      case "interrupted":
        return null;
      case "failed":
        return outcome.message;
      case "created-unavailable":
        return "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.";
    }
  };
}
