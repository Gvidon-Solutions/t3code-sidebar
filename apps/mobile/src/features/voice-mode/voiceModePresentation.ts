import {
  describeVoiceEnd,
  type VoiceModePhase,
  type VoiceModeState,
} from "@t3tools/client-runtime/voice-mode";

export type VoiceStripStatus = "connecting" | "listening" | "speaking" | "muted";

export const VOICE_STRIP_STATUS_LABEL: Record<VoiceStripStatus, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  speaking: "Speaking",
  muted: "Muted",
};

/** The assistant's voice outranks mute: while it talks, that is what the user hears. */
export function resolveVoiceStripStatus(input: {
  readonly phase: VoiceModePhase;
  readonly muted: boolean;
  readonly speaking: boolean;
}): VoiceStripStatus {
  if (input.phase !== "active") return "connecting";
  if (input.speaking) return "speaking";
  return input.muted ? "muted" : "listening";
}

const SPEAKING_LEVEL = 0.02;
const SPEAKING_HOLD_MS = 600;

/**
 * Turns sampled speaker levels into a steady "speaking" flag. The flag holds
 * through the short gaps between words so the status label does not flicker.
 */
export function createSpeakingDetector(): (level: number, nowMs: number) => boolean {
  let lastLoudAtMs: number | null = null;
  return (level, nowMs) => {
    if (level >= SPEAKING_LEVEL) lastLoudAtMs = nowMs;
    return lastLoudAtMs !== null && nowMs - lastLoudAtMs < SPEAKING_HOLD_MS;
  };
}

/** Maps a linear 0..1 audio level to meter height; speech sits low on the linear scale. */
export function voiceMeterLevel(level: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, level)) * 1.6);
}

// Native text only truncates multi-line text at the end, so captions keep their tail.
export { voiceCaptionTail } from "@t3tools/client-runtime/voice-mode";

export interface VoiceModeNotice {
  readonly title: string;
  readonly message?: string;
}

/** What to tell the user about a finished conversation. Null when they ended it themselves. */
export function resolveVoiceModeNotice(state: VoiceModeState): VoiceModeNotice | null {
  if (state.phase !== "idle") return null;
  if (state.error) return { title: "Voice conversation failed", message: state.error };
  if (state.endedReason) {
    if (state.endedReason === "ended") return { title: "Voice conversation ended" };
    // The phone has no windows: another device started voice on the same thread.
    const message =
      state.endedReason === "replaced"
        ? "The conversation moved to another device."
        : describeVoiceEnd(state.endedReason);
    return { title: "Voice conversation ended", message };
  }
  return null;
}

/** Keys a conversation's thread the way Home and the drawer key thread rows. */
export function voiceTargetKey(target: {
  readonly environmentId: string;
  readonly threadId: string;
}): string {
  return `${target.environmentId}:${target.threadId}`;
}
