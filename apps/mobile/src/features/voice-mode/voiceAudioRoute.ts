import { requireOptionalNativeModule, type NativeModule } from "expo";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

/** Where a voice conversation is heard and picked up (Android, sidebar fork). */
export type VoiceAudioRoute = "bluetooth" | "wired" | "speaker" | "earpiece";

export interface VoiceAudioDevice {
  readonly id: number;
  readonly route: VoiceAudioRoute;
  /** The product name; meaningful for headsets, the phone's model otherwise. */
  readonly name: string;
  readonly selected: boolean;
}

export interface VoiceAudioState {
  readonly route: VoiceAudioRoute | null;
  readonly devices: ReadonlyArray<VoiceAudioDevice>;
}

declare class T3VoiceAudioModule extends NativeModule<{
  onChange: (state: VoiceAudioState) => void;
}> {
  start(): VoiceAudioState;
  select(id: number): VoiceAudioState;
  stop(): void;
}

// WebRTC on Android plays and records as a call but leaves routing to the
// app; this module picks the call device (Bluetooth, wired, speaker) and lets
// the owner pick another. iOS routes headsets itself.
const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<T3VoiceAudioModule>("T3VoiceAudio")
    : null;

export const voiceAudioRoutingSupported = native !== null;

const IDLE: VoiceAudioState = { route: null, devices: [] };
let state: VoiceAudioState = IDLE;
const listeners = new Set<() => void>();
let subscription: { remove(): void } | null = null;

function setState(next: VoiceAudioState) {
  state = next;
  for (const listener of listeners) listener();
}

/** Starts call routing for a conversation; re-picks the device as headsets come and go. */
export function startVoiceAudioRouting(): void {
  if (native === null) return;
  subscription ??= native.addListener("onChange", setState);
  setState(native.start());
}

/** Ends call routing and restores the phone's previous audio mode. */
export function stopVoiceAudioRouting(): void {
  if (native === null) return;
  native.stop();
  subscription?.remove();
  subscription = null;
  setState(IDLE);
}

/** Talks through this device while it stays connected. */
export function selectVoiceAudioDevice(id: number): void {
  if (native === null) return;
  setState(native.select(id));
}

function getState(): VoiceAudioState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The live conversation's routing; empty off Android or while voice is off. */
export function useVoiceAudioState(): VoiceAudioState {
  return useSyncExternalStore(subscribe, getState, getState);
}
