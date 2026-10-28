import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { VoiceSessionTarget } from "@t3tools/client-runtime/voice-mode";
import {
  ThreadId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback } from "react";
import { Alert } from "react-native";

import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShellReady } from "../threads/threadForkNavigation";
import { VOICE_THREAD_TITLE } from "./voiceThreads";

/**
 * Sidebar fork: creates an empty server thread to talk in; the server opens the provider session
 * when voice starts. Resolves once the thread's shell reached this client, so its screen opens on
 * the thread, or null after telling the user why it failed.
 */
export function useCreateVoiceThread() {
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });

  return useCallback(
    async (input: {
      readonly project: EnvironmentProject;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly branch: string | null;
      readonly worktreePath: string | null;
    }): Promise<VoiceSessionTarget | null> => {
      const { environmentId } = input.project;
      const threadId = ThreadId.make(uuidv4());
      const result = await createThread({
        environmentId,
        input: {
          threadId,
          projectId: input.project.id,
          title: VOICE_THREAD_TITLE,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          branch: input.branch,
          worktreePath: input.worktreePath,
          creationSource: "mobile",
        },
      });
      if (result._tag !== "Success") {
        const error = Cause.squash(result.cause);
        Alert.alert(
          "Could not start a voice conversation",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The thread could not be created.",
        );
        return null;
      }
      const shellAtom = environmentThreadShells.threadShellAtom(
        scopeThreadRef(environmentId, threadId),
      );
      // The server has the thread either way; this only spares the screen a loading flash.
      await waitForThreadShellReady({
        read: () => appAtomRegistry.get(shellAtom) !== null,
        timeoutMs: 5_000,
      });
      return { environmentId, threadId };
    },
    [createThread],
  );
}
