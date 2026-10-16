import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { appliesVoiceCommand } from "../uiRequests.ts";
import { applyVoiceCommand, whenVoiceQuiet } from "./commands.ts";
import type {
  VoiceLevels,
  VoiceModeController,
  VoiceModeState,
  VoiceSessionTarget,
} from "./controller.ts";
import { INITIAL_VOICE_MODE_STATE } from "./controller.ts";

const held: VoiceSessionTarget = { environmentId: "env-1", threadId: "thread-voice" };

function makeController() {
  let state: VoiceModeState = { ...INITIAL_VOICE_MODE_STATE, phase: "active", target: held };
  const levelListeners = new Set<(levels: VoiceLevels) => void>();
  const calls: Array<string> = [];
  const controller = {
    getState: () => state,
    subscribeLevels: (listener: (levels: VoiceLevels) => void) => {
      levelListeners.add(listener);
      return () => levelListeners.delete(listener);
    },
    setMuted: (muted: boolean) => {
      calls.push(`mute:${muted}`);
      state = { ...state, muted };
    },
    stop: () => {
      calls.push("stop");
      state = { ...INITIAL_VOICE_MODE_STATE, target: state.target };
    },
    start: async (target: VoiceSessionTarget) => {
      calls.push(`start:${target.threadId}`);
      state = { ...state, phase: "connecting", target };
    },
  };
  const speak = (speaker: number) => {
    for (const listener of levelListeners) listener({ microphone: 0, speaker });
  };
  const replace = (target: VoiceSessionTarget) => {
    state = { ...state, target };
  };
  return { controller: controller as unknown as VoiceModeController, calls, speak, replace };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("appliesVoiceCommand", () => {
  const command = { id: "voice-command:1", threadId: "thread-voice", action: { type: "end" } };

  it("applies only on the client holding the thread's conversation", () => {
    expect(appliesVoiceCommand({ command: command as never, voiceThreadId: "thread-voice" })).toBe(
      true,
    );
    expect(appliesVoiceCommand({ command: command as never, voiceThreadId: "thread-other" })).toBe(
      false,
    );
    expect(appliesVoiceCommand({ command: command as never, voiceThreadId: null })).toBe(false);
  });
});

describe("whenVoiceQuiet", () => {
  it("waits for the assistant to stop talking", async () => {
    const { controller, speak } = makeController();
    let quiet = false;
    void whenVoiceQuiet(controller).then(() => (quiet = true));
    for (let tick = 0; tick < 10; tick += 1) {
      vi.advanceTimersByTime(100);
      speak(0.3);
    }
    await Promise.resolve();
    expect(quiet).toBe(false);
    for (let tick = 0; tick < 8; tick += 1) {
      vi.advanceTimersByTime(100);
      speak(0);
    }
    await Promise.resolve();
    expect(quiet).toBe(true);
  });

  it("gives up after a few seconds of talking", async () => {
    const { controller, speak } = makeController();
    let quiet = false;
    void whenVoiceQuiet(controller).then(() => (quiet = true));
    speak(0.3);
    vi.advanceTimersByTime(6_000);
    await Promise.resolve();
    expect(quiet).toBe(true);
  });
});

describe("applyVoiceCommand", () => {
  it("mutes at once and keeps the call", async () => {
    const { controller, calls } = makeController();
    await applyVoiceCommand(controller, { type: "mute" }, () => undefined);
    expect(calls).toEqual(["mute:true"]);
    expect(controller.getState().phase).toBe("active");
  });

  it("hangs up once the assistant is quiet", async () => {
    const { controller, calls, speak } = makeController();
    const done = applyVoiceCommand(controller, { type: "end" }, () => undefined);
    vi.advanceTimersByTime(800);
    speak(0);
    await done;
    expect(calls).toEqual(["stop"]);
  });

  it("moves the call: hangs up, opens the target, calls there", async () => {
    const { controller, calls, speak } = makeController();
    const opened: Array<VoiceSessionTarget> = [];
    const done = applyVoiceCommand(
      controller,
      { type: "move", threadId: "thread-next" as never },
      (target) => opened.push(target),
    );
    vi.advanceTimersByTime(800);
    speak(0);
    await done;
    expect(calls).toEqual(["stop", "start:thread-next"]);
    expect(opened).toEqual([{ environmentId: "env-1", threadId: "thread-next" }]);
  });

  it("leaves a conversation the owner replaced meanwhile alone", async () => {
    const { controller, calls, speak, replace } = makeController();
    const done = applyVoiceCommand(controller, { type: "end" }, () => undefined);
    replace({ environmentId: "env-1", threadId: "thread-other" });
    vi.advanceTimersByTime(800);
    speak(0);
    await done;
    expect(calls).toEqual([]);
  });

  it("does nothing without a live conversation", async () => {
    const { controller, calls } = makeController();
    controller.stop();
    calls.length = 0;
    await applyVoiceCommand(controller, { type: "mute" }, () => undefined);
    expect(calls).toEqual([]);
  });
});
