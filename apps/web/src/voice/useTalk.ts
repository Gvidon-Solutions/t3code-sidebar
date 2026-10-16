import { useMemo } from "react";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { resolveThreadActionProjectRef } from "../lib/chatThreadActions";
import { useServerConfigs } from "../state/entities";
import { useStartVoiceThread } from "./useStartVoiceThread";
import { findVoiceProvider } from "./voiceAvailability";

/**
 * "Talk": a new voice conversation in the current project (the one "New
 * thread" picks), on the environment's voice provider. Null when there is no
 * project or that environment has no voice provider, so callers hide it.
 */
export function useTalk(): (() => void) | null {
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const serverConfigs = useServerConfigs();
  const startVoiceThread = useStartVoiceThread();
  const projectRef = resolveThreadActionProjectRef({
    activeDraftThread,
    activeThread: activeThread ?? undefined,
    defaultProjectRef,
    handleNewThread,
  });
  const environmentId = projectRef?.environmentId ?? null;
  const projectId = projectRef?.projectId ?? null;
  const hasVoice =
    environmentId !== null &&
    findVoiceProvider(serverConfigs.get(environmentId)?.providers ?? []) !== undefined;
  return useMemo(
    () =>
      environmentId !== null && projectId !== null && hasVoice
        ? () =>
            void startVoiceThread({
              environmentId,
              projectId,
              modelSelection: null,
              branch: null,
              worktreePath: null,
            })
        : null,
    [environmentId, hasVoice, projectId, startVoiceThread],
  );
}
