import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import {
  backgroundActivitySharedPolicySettings,
  buildProviderInstanceUpdatePatch,
  getChangedBrowserSettingLabels,
  hasChangedBackgroundActivitySettings,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
} from "./SettingsPanels.logic";

describe("background activity settings restore", () => {
  it("detects legacy interval values even when the structured setting is at its default", () => {
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: Duration.seconds(45),
        providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      }),
    ).toBe(true);
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
        providerHealthRefreshInterval: Duration.minutes(7),
      }),
    ).toBe(true);
    expect(hasChangedBackgroundActivitySettings(DEFAULT_UNIFIED_SETTINGS)).toBe(false);
  });

  it("preserves advanced overrides when the shared policy changes", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          backgroundActivity: {
            schemaVersion: 1,
            profile: "custom",
            baseProfile: "balanced",
            overrides: {
              automaticGitFetchInterval,
              pauseWhenOnBattery: true,
            },
          },
        },
        "performance",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval,
        pauseWhenOnBattery: true,
      },
    });
  });

  it("materializes legacy advanced overrides before changing the shared policy", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          automaticGitFetchInterval,
        },
        "battery-saver",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval,
      },
    });
  });
});

describe("getChangedBrowserSettingLabels", () => {
  it("counts a retained custom search URL so restore clears it", () => {
    expect(
      getChangedBrowserSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        browserCustomSearchUrl: "https://search.example/?q=%s",
      }),
    ).toEqual(["Search engine"]);
  });
});

describe("project grouping toggle", () => {
  it("restores name grouping when the toggle is cycled", () => {
    expect(isProjectGroupingEnabled("title")).toBe(true);
    expect(projectGroupingModeFromToggle(false, "title")).toBe("separate");
    expect(projectGroupingModeFromToggle(true, "title")).toBe("title");
  });
});

describe("buildProviderInstanceUpdatePatch", () => {
  const codex = ProviderInstanceId.make("codex");
  const opencode = ProviderInstanceId.make("opencode");
  const current = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [codex]: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
      [opencode]: { driver: ProviderDriverKind.make("opencode"), enabled: true, config: {} },
    },
  };

  it("sends only the changed instance so other accounts survive the merge", () => {
    const patch = buildProviderInstanceUpdatePatch({
      instanceId: codex,
      instance: {
        driver: ProviderDriverKind.make("codex"),
        displayName: "Work",
        enabled: true,
        config: {},
      },
    });
    expect(Object.keys(patch.providerInstances ?? {})).toEqual([codex]);
    const next = applyServerSettingsPatch(current, patch);
    expect(next.providerInstances[codex]?.displayName).toBe("Work");
    expect(next.providerInstances[opencode]).toBe(current.providerInstances[opencode]);
  });

  it("deletes only the named instance with null", () => {
    const next = applyServerSettingsPatch(
      current,
      buildProviderInstanceUpdatePatch({ instanceId: codex, instance: null }),
    );
    expect(next.providerInstances[codex]).toBeUndefined();
    expect(next.providerInstances[opencode]).toBe(current.providerInstances[opencode]);
  });
});
