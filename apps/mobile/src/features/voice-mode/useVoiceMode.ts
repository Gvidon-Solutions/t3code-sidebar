import type {
  VoiceModePhase,
  VoiceModeState,
  VoiceSessionTarget,
} from "@t3tools/client-runtime/voice-mode";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { Alert } from "react-native";

import { useThreadShell } from "../../state/entities";
import { voiceMode } from "./voiceMode";
import { resolveVoiceModeNotice, voiceTargetKey } from "./voiceModePresentation";

export function useVoiceModeState(): VoiceModeState {
  return useSyncExternalStore(voiceMode.subscribe, voiceMode.getState);
}

/** This thread's conversation phase. A primitive, so captions do not re-render the caller. */
export function useVoiceModePhase(target: VoiceSessionTarget): VoiceModePhase {
  const { environmentId, threadId } = target;
  const getSnapshot = useCallback(
    () =>
      voiceMode.isActiveFor({ environmentId, threadId }) ? voiceMode.getState().phase : "idle",
    [environmentId, threadId],
  );
  return useSyncExternalStore(voiceMode.subscribe, getSnapshot);
}

function readLiveVoiceKey(): string | null {
  const { phase, target } = voiceMode.getState();
  return phase === "idle" || target === null ? null : voiceTargetKey(target);
}

/**
 * `environmentId:threadId` of the conversation running on this device, or
 * null. A primitive, so captions and levels do not re-render the caller.
 */
export function useLiveVoiceKey(): string | null {
  return useSyncExternalStore(voiceMode.subscribe, readLiveVoiceKey);
}

/** The thread holding this device's conversation and its title, or null when none runs. */
export function useLiveVoiceThread() {
  const key = useLiveVoiceKey();
  // The key changes with the target, so the target read here is the live one.
  const target = useMemo(() => (key === null ? null : voiceMode.getState().target), [key]);
  const shell = useThreadShell(
    useMemo(
      () =>
        target === null
          ? null
          : scopeThreadRef(
              EnvironmentId.make(target.environmentId),
              ThreadId.make(target.threadId),
            ),
      [target],
    ),
  );
  return target === null ? null : { target, title: shell?.title || "Untitled thread" };
}

/** Whether the microphone is muted. A primitive, for compact controls. */
export function useVoiceModeMuted(): boolean {
  return useSyncExternalStore(voiceMode.subscribe, () => voiceMode.getState().muted);
}

/**
 * Reports a failed conversation or one the server ended, once, wherever the
 * user is. Mount once at the root: a conversation outlives its thread screen.
 */
export function useVoiceModeNotices(): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shows voice session notices from the voice-mode store as native alerts
  useEffect(() => {
    // Reads the live state: dismissing notifies listeners re-entrantly, so a
    // listener's argument can already be stale.
    const report = () => {
      const notice = resolveVoiceModeNotice(voiceMode.getState());
      if (!notice) return;
      voiceMode.dismiss();
      Alert.alert(notice.title, notice.message);
    };
    report();
    return voiceMode.subscribe(report);
  }, []);
}
