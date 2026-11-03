import { describe, expect, it } from "vite-plus/test";
import { defaultDraftMachine, machineForDraftModel } from "./draftMachine.ts";

describe("draft machine defaults", () => {
  const machines = [
    { environmentId: "primary", connected: true, usable: false, primary: true },
    { environmentId: "authenticated", connected: true, usable: true, primary: false },
    { environmentId: "offline", connected: false, usable: true, primary: false },
  ];
  it("honours an explicit device preference before model availability", () => {
    expect(defaultDraftMachine(machines, "primary")).toBe("primary");
    expect(defaultDraftMachine(machines, "offline")).toBe("offline");
  });
  it("prefers an authenticated connected machine, then the primary", () => {
    expect(defaultDraftMachine(machines, null)).toBe("authenticated");
    expect(
      defaultDraftMachine(
        machines.map((machine) => ({ ...machine, usable: false })),
        null,
      ),
    ).toBe("primary");
    expect(defaultDraftMachine(machines, "removed")).toBe("authenticated");
    expect(defaultDraftMachine([], null)).toBeNull();
  });
});

import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";
import { draftModelUnavailableReason } from "./draftMachine.ts";

it("maps authentication, installation, availability and missing models", () => {
  const instanceId = ProviderInstanceId.make("claude");
  const selection = { instanceId, model: "sonnet" };
  const config = (patch: Record<string, unknown> = {}) =>
    ({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: { [instanceId]: { driver: "claudeCode", enabled: true, config: {} } },
      },
      providers: [
        {
          instanceId,
          driver: "claudeCode",
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
          auth: { status: "authenticated" },
          models: [{ slug: "sonnet" }],
          ...patch,
        },
      ],
    }) as unknown as Pick<ServerConfig, "providers" | "settings">;
  expect(draftModelUnavailableReason(config(), selection, null)).toBeNull();
  expect(
    draftModelUnavailableReason(config({ auth: { status: "unauthenticated" } }), selection, null),
  ).toBe("Provider not authenticated");
  expect(draftModelUnavailableReason(config({ installed: false }), selection, null)).toBe(
    "Provider not installed",
  );
  expect(
    draftModelUnavailableReason(config({ availability: "unavailable" }), selection, null),
  ).toBe("Provider unavailable");
  expect(draftModelUnavailableReason(config({ models: [] }), selection, null)).toBe(
    "Model unavailable",
  );
  expect(draftModelUnavailableReason({ ...config(), providers: [] }, selection, null)).toBe(
    "Provider not configured on this machine",
  );
  expect(draftModelUnavailableReason(null, selection, null)).toBe(
    "Machine configuration unavailable",
  );
});

import { defaultUsableDraftModel } from "./draftMachine.ts";
it("uses the configured usable local default before catalog order", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const selection = { instanceId, model: "preferred" };
  const config = {
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: selection },
    providers: [
      {
        instanceId,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [{ slug: "first" }, { slug: "preferred" }],
      },
    ],
  } as unknown as Pick<ServerConfig, "providers" | "settings">;
  expect(defaultUsableDraftModel(config, null)).toEqual(selection);
  expect(
    machineForDraftModel(
      [
        { environmentId: "offline", connected: false, config, projectId: null },
        {
          environmentId: "unauthenticated",
          connected: true,
          config: {
            ...config,
            providers: config.providers.map((provider) => ({
              ...provider,
              auth: { status: "unauthenticated" as const },
            })),
          },
          projectId: null,
        },
        { environmentId: "authenticated", connected: true, config, projectId: null },
      ],
      selection,
    )?.environmentId,
  ).toBe("authenticated");
  expect(
    defaultUsableDraftModel(
      {
        ...config,
        settings: { ...config.settings, defaultModelSelection: { instanceId, model: "missing" } },
      },
      null,
    ),
  ).toEqual({ instanceId, model: "first" });
  expect(defaultUsableDraftModel(null, null)).toBeNull();
});
