import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { nextForkTitle, planForkPlacement } from "@t3tools/client-runtime/state/thread-forks";
import type { RunId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
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
    const sourceThread = readThreadShell(source);
    if (!sourceThread) return "This thread is no longer available.";
    const { environmentId } = source;
    const sameEnvironment = () =>
      readThreadShells().filter((thread) => thread.environmentId === environmentId);
    const targetThreadId = newThreadId();
    const targetRef = scopeThreadRef(environmentId, targetThreadId);
    const result = await forkFromRun({
      environmentId,
      input: {
        sourceThreadId: source.threadId,
        targetThreadId,
        ...(runId === undefined ? {} : { runId }),
        title: nextForkTitle(
          sourceThread.title,
          sameEnvironment().map((thread) => thread.title),
        ),
      },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return null;
      const error = squashAtomCommandFailure(result);
      return error instanceof Error ? error.message : "Failed to fork this thread.";
    }
    if (!(await waitForThreadShell(targetRef))) {
      return "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.";
    }
    const placement = planForkPlacement({
      threads: sameEnvironment().filter((thread) => thread.projectId === sourceThread.projectId),
      sourceId: source.threadId,
      forkId: targetThreadId,
      now: new Date().toISOString(),
    });
    // Placement is cosmetic: a failed write leaves the fork on top.
    await Promise.all(
      placement.map((write) =>
        reorderActiveThread(scopeThreadRef(environmentId, write.id as ThreadId), write.orderKey),
      ),
    );
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(targetRef),
    });
    return null;
  };
}
