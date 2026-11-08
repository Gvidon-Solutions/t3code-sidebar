/**
 * Web entry to the shared voice rules. The decision itself lives in
 * `@t3tools/client-runtime/voice-availability` so web and mobile cannot drift:
 * the same install/auth/project/model checks hide the mic everywhere.
 */
export {
  VOICE_THREAD_MODEL,
  VOICE_THREAD_TITLE,
  resolveComposerVoiceAvailability,
  resolveThreadVoiceAvailability,
  resolveVoiceThreadModelSelection,
  type VoiceAvailability,
} from "@t3tools/client-runtime/voice-availability";
