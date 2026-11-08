import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { resolveThreadActionProjectRef } from "../lib/chatThreadActions";
import { useEnvironmentProviders } from "../state/environments";
import { useServerConfigs } from "../state/entities";
import { useStartVoiceThread } from "./useStartVoiceThread";
import { resolveComposerVoiceAvailability } from "./voiceAvailability";

/**
 * "Talk": a new voice conversation in the current project (the one "New
 * thread" picks), on the environment's voice provider. Null when the project's
 * machine has no usable voice model for it, so callers hide it.
 */
export function useTalk(): (() => void) | null {
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const providersByEnvironment = useEnvironmentProviders();
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
  const serverConfig = environmentId === null ? null : (serverConfigs.get(environmentId) ?? null);
  const providers = environmentId === null ? null : providersByEnvironment.get(environmentId);
  const catalog = serverConfig && providers ? { providers, settings: serverConfig.settings } : null;
  const availability =
    projectId === null
      ? null
      : resolveComposerVoiceAvailability({
          isServerThread: false,
          threadProviderInstanceId: null,
          config: catalog,
          projectId,
        });
  return environmentId !== null && projectId !== null && availability?.kind === "ready"
    ? () =>
        void startVoiceThread({
          environmentId,
          projectId,
          modelSelection: null,
          branch: null,
          worktreePath: null,
        })
    : null;
}
