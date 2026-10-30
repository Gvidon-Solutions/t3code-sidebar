import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  VoiceModeController,
  describeVoiceEnd,
  makeVoiceSessionOpener,
  type VoiceCaption,
  type VoiceMediaStream,
  type VoiceModePhase,
  type VoiceModePlatform,
  type VoiceModeState,
  type VoicePeerConnection,
  type VoiceSessionTarget,
} from "@t3tools/client-runtime/voice-mode";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { useEffect, useState, useSyncExternalStore } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import type { VoiceAvailability } from "./voiceAvailability";

function getMicrophone(): Promise<MediaStream> {
  const mediaDevices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  // Browsers only expose the microphone API on secure origins, so a remote
  // environment opened over plain HTTP has no `mediaDevices` at all.
  if (!mediaDevices?.getUserMedia) {
    return Promise.reject(
      new Error("Voice needs microphone access, which requires HTTPS when connecting remotely."),
    );
  }
  return mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

function playRemoteAudio(stream: VoiceMediaStream): () => void {
  const audio = new Audio();
  audio.autoplay = true;
  audio.srcObject = stream as MediaStream;
  void audio.play().catch(() => undefined);
  return () => {
    audio.pause();
    audio.srcObject = null;
  };
}

// The voice stream runs on the connection runtime, which owns the environment
// registry. Mounting keeps that runtime alive for the conversation.
const openSession = makeVoiceSessionOpener((effect) =>
  Effect.runFork(
    Effect.scoped(
      AtomRegistry.mount(appAtomRegistry, connectionAtomRuntime).pipe(
        Effect.andThen(AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime)),
        Effect.flatMap((context) => Effect.provideContext(effect, context)),
      ),
    ).pipe(Effect.orDie),
  ),
);

const platform: VoiceModePlatform = {
  // The DOM's overloaded addEventListener does not fit the structural `never`
  // listener in VoicePeerConnection, though the runtime shape matches.
  createPeerConnection: () => new RTCPeerConnection() as unknown as VoicePeerConnection,
  getMicrophone,
  playRemoteAudio,
  openSession,
};

/** The app's single voice conversation. The microphone is exclusive, so there is one per client. */
export const voiceMode = new VoiceModeController(platform);

export function isVoiceTargetFor(
  state: VoiceModeState,
  target: VoiceSessionTarget | null,
): boolean {
  return (
    target !== null &&
    state.target !== null &&
    state.target.environmentId === target.environmentId &&
    state.target.threadId === target.threadId
  );
}

export function useVoiceModeState(): VoiceModeState {
  return useSyncExternalStore(voiceMode.subscribe, voiceMode.getState, voiceMode.getState);
}

/** The conversation phase on `target`; "idle" while voice is off or on another thread. */
export function useVoicePhaseFor(target: VoiceSessionTarget | null): VoiceModePhase {
  const getPhase = () => {
    const state = voiceMode.getState();
    return isVoiceTargetFor(state, target) ? state.phase : "idle";
  };
  return useSyncExternalStore(voiceMode.subscribe, getPhase, getPhase);
}

/** Starts or stops voice on `target`. */
export function toggleThreadVoice(target: VoiceSessionTarget, availability: VoiceAvailability) {
  if (voiceMode.isActiveFor(target)) {
    voiceMode.stop();
    return;
  }
  if (availability.kind === "unsupported") return;
  void voiceMode.start(target);
}

export function voiceTargetRef(target: VoiceSessionTarget): ScopedThreadRef {
  return scopeThreadRef(EnvironmentId.make(target.environmentId), ThreadId.make(target.threadId));
}

const getEngagedTarget = () => {
  const state = voiceMode.getState();
  return state.phase === "idle" ? null : state.target;
};

/** The thread holding this client's conversation, or null while voice is off. */
export function useVoiceThreadRef(): ScopedThreadRef | null {
  const target = useSyncExternalStore(voiceMode.subscribe, getEngagedTarget, getEngagedTarget);
  return target === null ? null : voiceTargetRef(target);
}

const getMuted = () => voiceMode.getState().muted;

export function useVoiceMuted(): boolean {
  return useSyncExternalStore(voiceMode.subscribe, getMuted, getMuted);
}

const getCaptions = () => voiceMode.getState().captions;

export function useVoiceCaptions(): ReadonlyArray<VoiceCaption> {
  return useSyncExternalStore(voiceMode.subscribe, getCaptions, getCaptions);
}

/** Speaker loudness (WebRTC `audioLevel`, 0..1) above which the assistant counts as speaking. */
export const SPEAKING_LEVEL = 0.02;

/** Whether the assistant is talking right now; re-renders only when that flips. */
export function useVoiceSpeaking(active: boolean): boolean {
  const [speaking, setSpeaking] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the voice session's audio levels
  useEffect(() => {
    if (!active) return;
    return voiceMode.subscribeLevels((levels) => setSpeaking(levels.speaker > SPEAKING_LEVEL));
  }, [active]);
  return active && speaking;
}

// Errors and provider-side ends surface once as a toast wherever the user is:
// the conversation follows them around the app. A user stop leaves neither
// set, so it stays silent.
let lastPhase: VoiceModePhase = "idle";
voiceMode.subscribe((state) => {
  const previousPhase = lastPhase;
  lastPhase = state.phase;
  if (state.phase !== "idle" || state.target === null) return;
  if (state.error === null && state.endedReason === null) return;
  if (state.error !== null) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: previousPhase === "active" ? "Voice conversation ended" : "Couldn't start voice",
        description: state.error,
      }),
    );
  } else if (state.endedReason !== null) {
    toastManager.add({ type: "info", title: describeVoiceEnd(state.endedReason) });
  }
  voiceMode.dismiss();
});
