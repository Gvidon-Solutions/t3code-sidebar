import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  filterSharedServerPatch,
  meshLayoutHandlesSidebarWorkspaces,
  splitSharedServerPatch,
} from "./sharedSettings.ts";

describe("filterSharedServerPatch", () => {
  it("holds the restart preference until the target's config loads", () => {
    const patch = { continueThreadsAfterServerUpdate: true, sidebarAutoSettleAfterDays: 7 };
    expect(filterSharedServerPatch(patch, undefined)).toEqual({ sidebarAutoSettleAfterDays: 7 });
    expect(filterSharedServerPatch(patch, DEFAULT_SERVER_SETTINGS)).toEqual(patch);
  });

  it.each([true, false])(
    "resets a disabled default provider only on the originating environment (%s)",
    (targetIsSource) => {
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          codex: { driver: ProviderDriverKind.make("codex"), enabled: false, config: {} },
          claudeAgent: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: {},
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
      };
      const patch = {
        textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
        continueThreadsAfterServerUpdate: true,
        sidebarAutoSettleAfterDays: 7,
      };
      expect(filterSharedServerPatch(patch, settings, settings, targetIsSource)).toEqual({
        ...(targetIsSource
          ? { textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection }
          : {}),
        continueThreadsAfterServerUpdate: true,
        sidebarAutoSettleAfterDays: 7,
      });
    },
  );

  it.each(["missing", "disabled", "different-driver", "enabled"] as const)(
    "shares a custom model only when its target provider is enabled (%s)",
    (availability) => {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const selection = {
        instanceId,
        model: "gpt-5.6-luna",
        options: [{ id: "reasoningEffort", value: "low" }],
      };
      const instance = {
        driver: ProviderDriverKind.make(
          availability === "different-driver" ? "claudeAgent" : "codex",
        ),
        enabled: availability !== "disabled",
        config: {},
      };
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: availability === "missing" ? {} : { [instanceId]: instance },
      };
      const patch = { sidebarAutoSettleAfterDays: 7, textGenerationModelSelection: selection };
      const sourceSettings = {
        ...settings,
        providerInstances: {
          [instanceId]: { ...instance, driver: ProviderDriverKind.make("codex"), enabled: true },
        },
      };
      expect(filterSharedServerPatch(patch, settings, sourceSettings)).toEqual(
        availability === "enabled" ? patch : { sidebarAutoSettleAfterDays: 7 },
      );
    },
  );
});

describe("server settings classification", () => {
  it("shares text generators and keeps secret provider references local", () => {
    const { sharedPatch, localPatch } = splitSharedServerPatch({
      textGenerators: {},
      secretProviders: {},
    });
    expect(sharedPatch).toHaveProperty("textGenerators");
    expect(localPatch).toHaveProperty("secretProviders");
  });
});

describe("T3 Mesh sidebar workspace fan-out", () => {
  const patch = { sidebarWorkspaces: { ...DEFAULT_SERVER_SETTINGS.sidebarWorkspaces } };

  it("keeps writing the whole setting to legacy servers", () => {
    const environments = [
      { connected: true, hasWorkspaces: true, capabilities: { meshLayout: true } },
      { connected: true, hasWorkspaces: true, capabilities: {} },
    ];
    expect(meshLayoutHandlesSidebarWorkspaces(environments)).toBe(false);
    expect(splitSharedServerPatch(patch).sharedPatch).toEqual(patch);
  });

  it("drops the setting only when every connected server with workspaces speaks the mesh", () => {
    const environments = [
      { connected: true, hasWorkspaces: true, capabilities: { meshLayout: true } },
      { connected: false, hasWorkspaces: true, capabilities: {} },
      { connected: true, hasWorkspaces: false, capabilities: {} },
    ];
    expect(meshLayoutHandlesSidebarWorkspaces(environments)).toBe(true);
    expect(splitSharedServerPatch(patch, { meshLayoutHandlesSidebarWorkspaces: true })).toEqual({
      sharedPatch: {},
      localPatch: {},
    });
  });

  it("stays on the legacy path when no server has workspaces yet", () => {
    expect(
      meshLayoutHandlesSidebarWorkspaces([
        { connected: true, hasWorkspaces: false, capabilities: { meshLayout: true } },
      ]),
    ).toBe(false);
  });
});
