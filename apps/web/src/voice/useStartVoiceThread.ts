import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useRouter } from "@tanstack/react-router";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { newThreadId } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { waitForThreadShell } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { VOICE_THREAD_TITLE, resolveVoiceThreadModelSelection } from "./voiceAvailability";
import { voiceMode } from "./voiceMode";

export interface VoiceThreadInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** The model the caller would like; a provider without voice falls back to the voice model. */
  readonly modelSelection: ModelSelection | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  /** Defaults to the project's default runtime mode. */
  readonly runtimeMode?: RuntimeMode;
}

// One launch at a time: a second press while the thread is being created is a no-op.
let launching = false;

/**
 * Creates a thread for a voice conversation, opens it and starts voice there.
 * The server opens the provider session itself, so the thread needs no
 * message first. Used by drafts (their first action is voice) and "Talk".
 */
export function useStartVoiceThread() {
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const router = useRouter();
  return async (input: VoiceThreadInput): Promise<void> => {
    if (launching) return;
    const serverConfig = appAtomRegistry.get(environmentServerConfigsAtom).get(input.environmentId);
    const modelSelection = resolveVoiceThreadModelSelection(
      input.modelSelection,
      serverConfig?.providers ?? [],
    );
    if (modelSelection === null) return;
    launching = true;
    // No try/finally: the React Compiler can't compile it. settlePromise catches
    // any throw so `launching` resets before the error goes on to the caller.
    const launched = await settlePromise(async () => {
      const threadId = newThreadId();
      const result = await createThread({
        environmentId: input.environmentId,
        input: {
          threadId,
          projectId: input.projectId,
          title: VOICE_THREAD_TITLE,
          modelSelection,
          runtimeMode:
            input.runtimeMode ??
            resolveProjectSettings(
              serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
              input.projectId,
            ).settings.defaultRuntimeMode,
          interactionMode: "default",
          branch: input.branch,
          worktreePath: input.worktreePath,
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Couldn't start voice",
              description: error instanceof Error ? error.message : "Could not create a thread.",
            }),
          );
        }
        return;
      }
      const threadRef = scopeThreadRef(input.environmentId, threadId);
      // The thread route sends a thread it cannot find back home, so wait for the shell.
      await waitForThreadShell(threadRef);
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
      void voiceMode.start(threadRef);
    });
    launching = false;
    if (launched._tag === "Failure") throw squashAtomCommandFailure(launched);
  };
}
