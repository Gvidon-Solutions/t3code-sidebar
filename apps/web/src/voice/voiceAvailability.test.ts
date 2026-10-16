import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  VOICE_THREAD_MODEL,
  resolveThreadVoiceAvailability,
  resolveVoiceThreadModelSelection,
} from "./voiceAvailability";

const codex = ProviderInstanceId.make("codex");
const codexWork = ProviderInstanceId.make("codex_work");
const claude = ProviderInstanceId.make("claudeAgent");
const providers = [
  { instanceId: claude, enabled: true },
  { instanceId: codex, supportsVoice: true, enabled: true },
] as unknown as ReadonlyArray<ServerProvider>;

describe("resolveThreadVoiceAvailability", () => {
  it("hides voice for providers that do not support it", () => {
    expect(resolveThreadVoiceAvailability({ providerInstanceId: claude }, providers)).toEqual({
      kind: "unsupported",
    });
  });

  it("is ready on any Codex thread, before its first message too", () => {
    expect(resolveThreadVoiceAvailability({ providerInstanceId: codex }, providers)).toEqual({
      kind: "ready",
    });
  });
});

describe("resolveVoiceThreadModelSelection", () => {
  it("keeps a selection whose provider holds voice", () => {
    const selection = { instanceId: codex, model: "gpt-6" };
    expect(resolveVoiceThreadModelSelection(selection, providers)).toBe(selection);
  });

  it("falls back to the voice provider's default voice model", () => {
    expect(
      resolveVoiceThreadModelSelection({ instanceId: claude, model: "opus" }, providers),
    ).toEqual({ instanceId: codex, model: VOICE_THREAD_MODEL });
    expect(resolveVoiceThreadModelSelection(null, providers)).toEqual({
      instanceId: codex,
      model: VOICE_THREAD_MODEL,
    });
  });

  it("skips disabled voice providers", () => {
    const withDisabled = [
      { instanceId: codexWork, supportsVoice: true, enabled: false },
      ...providers,
    ] as unknown as ReadonlyArray<ServerProvider>;
    expect(
      resolveVoiceThreadModelSelection({ instanceId: codexWork, model: "gpt-6" }, withDisabled),
    ).toEqual({ instanceId: codex, model: VOICE_THREAD_MODEL });
  });

  it("is null without a voice provider", () => {
    expect(resolveVoiceThreadModelSelection(null, [providers[0]!])).toBeNull();
  });
});
