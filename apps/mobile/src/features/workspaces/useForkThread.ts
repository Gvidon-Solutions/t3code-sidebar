import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runThreadFork } from "@t3tools/client-runtime/state/thread-forks";
import { type EnvironmentId, type RunId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback } from "react";
import { Alert } from "react-native";

import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShellReady } from "../threads/threadForkNavigation";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { forkOutcomeAlert } from "./forkOutcomeAlert";

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
      const outcome = await runThreadFork(source, runId, {
        readThread: (target) => {
          const found =
            appAtomRegistry
              .get(environmentThreadShells.threadShellsAtom)
              .find(
                (thread) =>
                  thread.environmentId === target.environmentId && thread.id === target.threadId,
              ) ?? null;
          return found;
        },
        threadsInEnvironment: (environmentId) =>
          appAtomRegistry
            .get(environmentThreadShells.threadShellsAtom)
            .filter((thread) => thread.environmentId === environmentId),
        createThreadId: () => ThreadId.make(uuidv4()),
        fork: async (input) => {
          const result = await forkFromRun({
            environmentId: source.environmentId,
            input: { ...input, creationSource: "mobile" },
          });
          if (result._tag === "Success") return { ok: true };
          const error = Cause.squash(result.cause);
          return {
            ok: false,
            interrupted: false,
            message:
              error instanceof Error && error.message.trim().length > 0
                ? error.message
                : "The thread could not be forked.",
          };
        },
        waitForThread: (target) =>
          waitForThreadShellReady({
            read: () =>
              appAtomRegistry.get(
                environmentThreadShells.threadShellAtom(
                  scopeThreadRef(target.environmentId, target.threadId),
                ),
              ) !== null,
          }),
        reorder: (target, orderKey) =>
          reorderActive({
            environmentId: target.environmentId,
            input: { threadId: target.threadId, orderKey },
          }),
        now: () => new Date().toISOString(),
      });
      switch (outcome.kind) {
        case "forked":
          selectDetail({
            name: "Thread",
            params: {
              environmentId: String(outcome.target.environmentId),
              threadId: String(outcome.target.threadId),
            },
          });
          return true;
        case "source-missing":
        case "interrupted":
        case "failed":
        case "created-unavailable": {
          const alert = forkOutcomeAlert(outcome);
          if (alert !== null) Alert.alert(alert.title, alert.message);
          return false;
        }
      }
    },
    [forkFromRun, selectDetail, reorderActive],
  );
}
