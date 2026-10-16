// @effect-diagnostics globalTimers:off globalDate:off - waits on WebRTC level callbacks, outside an Effect runtime.
import type { VoiceCommandAction } from "@t3tools/contracts";

import type { VoiceModeController, VoiceSessionTarget } from "./controller.ts";

/** Speaker loudness (WebRTC `audioLevel`, 0..1) above which the assistant counts as speaking. */
export const VOICE_SPEAKING_LEVEL = 0.02;
const QUIET_MS = 700;
const MAX_QUIET_WAIT_MS = 6_000;

/**
 * Resolves once the assistant has been silent for a moment, or after a few
 * seconds whatever it is doing, so a spoken goodbye is heard before hanging up.
 */
export function whenVoiceQuiet(
  controller: Pick<VoiceModeController, "subscribeLevels">,
  options: { readonly quietMs?: number; readonly maxWaitMs?: number } = {},
): Promise<void> {
  const quietMs = options.quietMs ?? QUIET_MS;
  return new Promise((resolve) => {
    let lastLoudAtMs = Date.now();
    let unsubscribe: (() => void) | null = null;
    const done = () => {
      clearTimeout(timeout);
      unsubscribe?.();
      resolve();
    };
    const timeout = setTimeout(done, options.maxWaitMs ?? MAX_QUIET_WAIT_MS);
    unsubscribe = controller.subscribeLevels((levels) => {
      const now = Date.now();
      if (levels.speaker >= VOICE_SPEAKING_LEVEL) lastLoudAtMs = now;
      else if (now - lastLoudAtMs >= quietMs) done();
    });
  });
}

/**
 * Fork: carries out a spoken command on the client holding the conversation
 * (see `decideVoiceCommand`). Ending and moving wait for the assistant to
 * finish its sentence; a conversation the owner ended or replaced meanwhile
 * is left alone. `openThread` shows the thread a moved conversation goes to.
 */
export async function applyVoiceCommand(
  controller: VoiceModeController,
  action: VoiceCommandAction,
  openThread: (target: VoiceSessionTarget) => void,
): Promise<void> {
  const held = controller.getState().target;
  if (held === null || controller.getState().phase === "idle") return;
  if (action.type === "mute") {
    controller.setMuted(true);
    return;
  }
  await whenVoiceQuiet(controller);
  const now = controller.getState();
  if (now.phase === "idle" || now.target !== held) return;
  if (action.type === "end") {
    controller.stop();
    return;
  }
  const next: VoiceSessionTarget = { environmentId: held.environmentId, threadId: action.threadId };
  controller.stop();
  openThread(next);
  await controller.start(next);
}
