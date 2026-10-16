import {
  VOICE_THREAD_DEFAULT_TITLE,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

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

export function resolveVoiceAvailability(
  /** The provider instance that runs (or will run) the thread's turns. */
  provider: Pick<ServerProvider, "supportsVoice"> | null | undefined,
): VoiceAvailability {
  return provider?.supportsVoice === true ? VOICE_READY : VOICE_UNSUPPORTED;
}

/** The thread fields voice availability reads (orchestrator V2 thread shells). */
export interface VoiceThread {
  readonly providerInstanceId: ProviderInstanceId;
}

/** Voice follows the provider instance that owns the thread. */
export function resolveThreadVoiceAvailability(
  thread: VoiceThread,
  providers: ReadonlyArray<ServerProvider>,
): VoiceAvailability {
  return resolveVoiceAvailability(
    providers.find((provider) => provider.instanceId === thread.providerInstanceId),
  );
}

/** The environment's provider instance that can hold voice conversations, if it has one. */
export function findVoiceProvider(
  providers: ReadonlyArray<ServerProvider>,
): ServerProvider | undefined {
  return providers.find(
    (provider) =>
      provider.supportsVoice === true &&
      provider.enabled &&
      provider.availability !== "unavailable",
  );
}

/**
 * The model a new voice thread runs: the selection itself when its provider
 * holds voice, otherwise the voice provider with VOICE_THREAD_MODEL. Null when
 * the environment has no voice provider.
 */
export function resolveVoiceThreadModelSelection(
  selection: ModelSelection | null,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  if (selection !== null) {
    const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
    if (provider && findVoiceProvider([provider])) return selection;
  }
  const voiceProvider = findVoiceProvider(providers);
  return voiceProvider ? { instanceId: voiceProvider.instanceId, model: VOICE_THREAD_MODEL } : null;
}
