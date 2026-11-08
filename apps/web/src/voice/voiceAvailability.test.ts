import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  VOICE_THREAD_MODEL,
  resolveComposerVoiceAvailability,
  resolveThreadVoiceAvailability,
  resolveVoiceThreadModelSelection,
} from "./voiceAvailability";

const codex = ProviderInstanceId.make("codex");
const codexWork = ProviderInstanceId.make("codex_work");
const claude = ProviderInstanceId.make("claudeAgent");
type Catalog = Pick<ServerConfig, "providers" | "settings">;

const config = (patch: Record<string, unknown> = {}): Catalog =>
  ({
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [claude]: { driver: "claudeCode", enabled: true, config: {} },
        [codex]: { driver: "codex", enabled: true, config: {} },
        [codexWork]: { driver: "codex", enabled: true, config: {} },
      },
    },
    providers: [
      {
        instanceId: claude,
        driver: "claudeCode",
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        auth: { status: "authenticated" },
        models: [{ slug: "opus" }],
      },
      {
        instanceId: codex,
        driver: "codex",
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        supportsVoice: true,
        auth: { status: "authenticated" },
        models: [{ slug: "gpt-6" }, { slug: VOICE_THREAD_MODEL }],
      },
      {
        instanceId: codexWork,
        driver: "codex",
        enabled: false,
        installed: true,
        status: "ready",
        availability: "available",
        supportsVoice: true,
        auth: { status: "authenticated" },
        models: [{ slug: "gpt-6" }],
      },
    ],
    ...patch,
  }) as unknown as Catalog;

const withProvider = (instanceId: ProviderInstanceId, patch: Record<string, unknown>): Catalog => {
  const base = config();
  return {
    ...base,
    providers: base.providers.map((provider) =>
      provider.instanceId === instanceId ? { ...provider, ...patch } : provider,
    ),
  } as unknown as Catalog;
};

describe("resolveThreadVoiceAvailability", () => {
  it("hides voice for providers that do not support it", () => {
    expect(
      resolveThreadVoiceAvailability({ providerInstanceId: claude }, config().providers),
    ).toEqual({ kind: "unsupported" });
  });

  it("is ready on any Codex thread, before its first message too", () => {
    expect(
      resolveThreadVoiceAvailability({ providerInstanceId: codex }, config().providers),
    ).toEqual({ kind: "ready" });
  });

  it("hides voice on an unauthenticated provider", () => {
    expect(
      resolveThreadVoiceAvailability(
        { providerInstanceId: codex },
        withProvider(codex, { auth: { status: "unauthenticated" } }).providers,
      ),
    ).toEqual({ kind: "unsupported" });
  });
});

describe("resolveVoiceThreadModelSelection", () => {
  it("keeps a selection whose provider holds voice", () => {
    const selection = { instanceId: codex, model: "gpt-6" };
    expect(resolveVoiceThreadModelSelection(config(), selection, null)).toBe(selection);
  });

  it("falls back to the voice provider's usable model", () => {
    expect(
      resolveVoiceThreadModelSelection(config(), { instanceId: claude, model: "opus" }, null),
    ).toEqual({ instanceId: codex, model: VOICE_THREAD_MODEL });
    expect(resolveVoiceThreadModelSelection(config(), null, null)).toEqual({
      instanceId: codex,
      model: VOICE_THREAD_MODEL,
    });
  });

  it("skips disabled, uninstalled and unauthenticated voice providers", () => {
    expect(
      resolveVoiceThreadModelSelection(withProvider(codex, { installed: false }), null, null),
    ).toBeNull();
    expect(
      resolveVoiceThreadModelSelection(
        withProvider(codex, { auth: { status: "unauthenticated" } }),
        null,
        null,
      ),
    ).toBeNull();
    expect(
      resolveVoiceThreadModelSelection(config(), { instanceId: codexWork, model: "gpt-6" }, null),
    ).toEqual({ instanceId: codex, model: VOICE_THREAD_MODEL });
  });
});

describe("resolveComposerVoiceAvailability", () => {
  it("follows the provider that owns a thread on another machine", () => {
    expect(
      resolveComposerVoiceAvailability({
        isServerThread: true,
        threadProviderInstanceId: codex,
        config: config(),
        projectId: null,
      }),
    ).toEqual({ kind: "ready" });
  });

  it("hides voice on a remote thread whose provider there has none", () => {
    expect(
      resolveComposerVoiceAvailability({
        isServerThread: true,
        threadProviderInstanceId: claude,
        config: config(),
        projectId: null,
      }),
    ).toEqual({ kind: "unsupported" });
  });

  it("uses the draft target machine's catalog and needs a project there", () => {
    expect(
      resolveComposerVoiceAvailability({
        isServerThread: false,
        threadProviderInstanceId: null,
        config: config(),
        projectId: ProjectId.make("project"),
      }),
    ).toEqual({ kind: "ready" });
    expect(
      resolveComposerVoiceAvailability({
        isServerThread: false,
        threadProviderInstanceId: null,
        config: config(),
        projectId: null,
      }),
    ).toEqual({ kind: "unsupported" });
    expect(
      resolveComposerVoiceAvailability({
        isServerThread: false,
        threadProviderInstanceId: null,
        config: null,
        projectId: ProjectId.make("project"),
      }),
    ).toEqual({ kind: "unsupported" });
  });
});
