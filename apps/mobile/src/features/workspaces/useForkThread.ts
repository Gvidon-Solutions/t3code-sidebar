import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { nextForkTitle, planForkPlacement } from "@t3tools/client-runtime/state/thread-forks";
import { type EnvironmentId, type RunId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useCallback } from "react";
import { Alert } from "react-native";

import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShellReady } from "../threads/threadForkNavigation";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

/**
 * Forks a thread (sidebar fork): "Title (n)", placed right under the source
 * in its project, then opened. Without `runId` it forks from the latest
 * completed response. Resolves true once the fork is open.
 */
export function useForkThread() {
  const selectDetail = useSelectWorkspaceDetail();
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, { reportFailure: false });
  const reorderActive = useAtomCommand(threadEnvironment.reorderActive, { reportFailure: false });

  return useCallback(
    async (
      source: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
      runId?: RunId,
    ): Promise<boolean> => {
      const { environmentId } = source;
      const sameEnvironment = () =>
        appAtomRegistry
          .get(environmentThreadShells.threadShellsAtom)
          .filter((thread) => thread.environmentId === environmentId);
      const sourceThread = sameEnvironment().find((thread) => thread.id === source.threadId);
      if (!sourceThread) return false;
      void Haptics.selectionAsync();
      const targetThreadId = ThreadId.make(uuidv4());
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
          creationSource: "mobile",
        },
      });
      if (result._tag !== "Success") {
        const error = Cause.squash(result.cause);
        Alert.alert(
          "Could not fork thread",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The thread could not be forked.",
        );
        return false;
      }
      const targetAtom = environmentThreadShells.threadShellAtom(
        scopeThreadRef(environmentId, targetThreadId),
      );
      const ready = await waitForThreadShellReady({
        read: () => appAtomRegistry.get(targetAtom) !== null,
      });
      if (!ready) {
        Alert.alert(
          "Fork created",
          "Its thread data did not reach this client. Reconnect and try opening it from the thread list.",
        );
        return false;
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
          reorderActive({
            environmentId,
            input: { threadId: ThreadId.make(write.id), orderKey: write.orderKey },
          }),
        ),
      );
      selectDetail({
        name: "Thread",
        params: { environmentId: String(environmentId), threadId: String(targetThreadId) },
      });
      return true;
    },
    [forkFromRun, selectDetail, reorderActive],
  );
}
