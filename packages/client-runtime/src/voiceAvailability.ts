import {
  VOICE_THREAD_DEFAULT_TITLE,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  draftModelUnavailableReason,
  type ProviderCatalog,
} from "./state/meshLayout/draftMachine.ts";

/**
 * Whether a thread can hold a voice conversation. `unsupported` hides every
 * voice entry point. The server opens the provider session itself, so any
 * thread it knows can start one, messages or not.
 */
export type VoiceAvailability = { readonly kind: "unsupported" } | { readonly kind: "ready" };

const VOICE_UNSUPPORTED: VoiceAvailability = { kind: "unsupported" };
const VOICE_READY: VoiceAvailability = { kind: "ready" };

/** The model a new voice thread runs when nothing better is selected. */
export const VOICE_THREAD_MODEL = "gpt-6-astra";
export const VOICE_THREAD_TITLE = VOICE_THREAD_DEFAULT_TITLE;

type VoiceProviderFacts = Pick<
  ServerProvider,
  "supportsVoice" | "enabled" | "installed" | "auth" | "status" | "availability"
>;

/** Only a provider that this device could actually start counts as voice-capable. */
function providerSupportsVoice(provider: VoiceProviderFacts | null | undefined): boolean {
  return (
    provider?.supportsVoice === true &&
    provider.enabled !== false &&
    provider.installed !== false &&
    provider.auth?.status !== "unauthenticated" &&
    provider.status !== "error" &&
    provider.availability !== "unavailable"
  );
}

/** A voice provider can run in this project when its catalog and settings allow it. */
function providerCanVoiceForProject(
  config: ProviderCatalog | null | undefined,
  instanceId: ProviderInstanceId,
  projectId: ProjectId | null,
): boolean {
  if (!config) return false;
  const provider = config.providers.find((candidate) => candidate.instanceId === instanceId);
  if (!provider || !providerSupportsVoice(provider)) return false;
  return provider.models.some(
    (model) =>
      draftModelUnavailableReason(
        config,
        { instanceId: provider.instanceId, model: model.slug },
        projectId,
      ) === null,
  );
}

function voiceModelForProvider(
  config: ProviderCatalog,
  provider: ServerProvider,
  projectId: ProjectId | null,
): ModelSelection | null {
  const preferred = provider.models.some((model) => model.slug === VOICE_THREAD_MODEL)
    ? VOICE_THREAD_MODEL
    : (provider.models.find((model) => model.isDefault)?.slug ??
      provider.models[0]?.slug ??
      VOICE_THREAD_MODEL);
  const selection = { instanceId: provider.instanceId, model: preferred };
  return draftModelUnavailableReason(config, selection, projectId) === null ? selection : null;
}

/**
 * The model a new voice thread runs: the selection itself when its provider
 * can hold voice here, otherwise the first voice provider with a usable model.
 * Null when the environment has no usable voice provider for the project.
 */
export function resolveVoiceThreadModelSelection(
  config: ProviderCatalog | null | undefined,
  selection: ModelSelection | null,
  projectId: ProjectId | null,
): ModelSelection | null {
  if (!config) return null;
  if (selection !== null && providerCanVoiceForProject(config, selection.instanceId, projectId)) {
    const provider = config.providers.find(
      (candidate) => candidate.instanceId === selection.instanceId,
    )!;
    if (draftModelUnavailableReason(config, selection, projectId) === null) return selection;
    const fallback = voiceModelForProvider(config, provider, projectId);
    if (fallback !== null) return fallback;
  }
  for (const provider of config.providers) {
    if (!providerCanVoiceForProject(config, provider.instanceId, projectId)) continue;
    const model = voiceModelForProvider(config, provider, projectId);
    if (model !== null) return model;
  }
  return null;
}

/** Voice follows the provider instance that owns the thread. */
export function resolveThreadVoiceAvailability(
  thread: { readonly providerInstanceId: ProviderInstanceId },
  providers: ReadonlyArray<ServerProvider>,
): VoiceAvailability {
  const provider = providers.find(
    (candidate) => candidate.instanceId === thread.providerInstanceId,
  );
  return providerSupportsVoice(provider) ? VOICE_READY : VOICE_UNSUPPORTED;
}

/**
 * The voice entry point for a composer route. A server thread follows the
 * provider that owns that thread on its own machine; a draft follows the
 * machine the draft targets. Both use the destination's settings and project
 * enablement, so the mic is hidden exactly when a voice thread could not start.
 */
export function resolveComposerVoiceAvailability(input: {
  readonly isServerThread: boolean;
  readonly threadProviderInstanceId: ProviderInstanceId | null;
  readonly config: ProviderCatalog | null | undefined;
  readonly projectId: ProjectId | null;
}): VoiceAvailability {
  if (!input.config) return VOICE_UNSUPPORTED;
  if (input.isServerThread) {
    return input.threadProviderInstanceId !== null &&
      providerCanVoiceForProject(input.config, input.threadProviderInstanceId, input.projectId)
      ? VOICE_READY
      : VOICE_UNSUPPORTED;
  }
  // A draft that is still waiting for its project on the target machine has
  // nowhere to create the voice thread yet; hide the mic instead of guessing.
  if (input.projectId === null) return VOICE_UNSUPPORTED;
  return resolveVoiceThreadModelSelection(input.config, null, input.projectId) !== null
    ? VOICE_READY
    : VOICE_UNSUPPORTED;
}
