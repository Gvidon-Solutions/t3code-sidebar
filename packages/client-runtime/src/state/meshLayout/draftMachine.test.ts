import { describe, expect, it } from "vite-plus/test";
import {
  defaultDraftMachine,
  draftMachineCatalogsKnown,
  hasUsableDraftModels,
  machineForDraftModel,
  nextSelectableDraftMachine,
} from "./draftMachine.ts";

describe("draft machine defaults", () => {
  const machines = [
    { environmentId: "primary", connected: true, usable: false, primary: true },
    { environmentId: "authenticated", connected: true, usable: true, primary: false },
    { environmentId: "offline", connected: false, usable: true, primary: false },
  ];
  it("only honours a device preference that can still run the draft", () => {
    const usableRemembered = machines.map((machine) =>
      machine.environmentId === "offline" ? { ...machine, connected: true } : machine,
    );
    expect(defaultDraftMachine(usableRemembered, "offline")).toBe("offline");
    expect(defaultDraftMachine(machines, "primary")).toBe("authenticated");
    expect(defaultDraftMachine(machines, "offline")).toBe("authenticated");
  });
  it("never picks an offline remembered machine", () => {
    const onlyOfflineRemembered = machines.filter(
      (machine) => machine.environmentId !== "authenticated",
    );
    expect(defaultDraftMachine(onlyOfflineRemembered, "offline")).toBe("primary");
  });
  it("falls back to the main copy when no machine is usable and keeps its reason", () => {
    const noneUsable = machines.map((machine) => ({ ...machine, usable: false }));
    expect(defaultDraftMachine(noneUsable, "offline")).toBe("primary");
    const noPrimary = [{ environmentId: "first", connected: false, usable: false, primary: false }];
    expect(defaultDraftMachine(noPrimary, null)).toBe("first");
  });
  it("cycles only through connected machines that have a usable model and wraps", () => {
    expect(nextSelectableDraftMachine(machines, "authenticated")).toBe("authenticated");
    const twoUsable = [
      { environmentId: "a", connected: true, usable: true, primary: true },
      { environmentId: "b", connected: false, usable: true, primary: false },
      { environmentId: "c", connected: true, usable: false, primary: false },
      { environmentId: "d", connected: true, usable: true, primary: false },
    ];
    expect(nextSelectableDraftMachine(twoUsable, "a")).toBe("d");
    expect(nextSelectableDraftMachine(twoUsable, "d")).toBe("a");
    expect(nextSelectableDraftMachine(twoUsable, "unknown")).toBe("a");
    expect(nextSelectableDraftMachine([], "a")).toBeNull();
    expect(
      nextSelectableDraftMachine(
        twoUsable.map((machine) => ({ ...machine, usable: false })),
        "a",
      ),
    ).toBeNull();
  });
  it("treats an unknown catalog as unknown rather than as no usable models", () => {
    expect(hasUsableDraftModels(null, null)).toBeNull();
  });
  it("prefers the project's main copy when it can run, then any authenticated machine", () => {
    expect(
      defaultDraftMachine(
        [
          { environmentId: "replica", connected: true, usable: true, primary: false },
          { environmentId: "main", connected: true, usable: true, primary: true },
        ],
        null,
      ),
    ).toBe("main");
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

it("waits for every connected machine's catalog before pinning a draft default", () => {
  const machines = [
    { environmentId: "a", connected: true },
    { environmentId: "b", connected: true },
    { environmentId: "c", connected: false },
  ];
  expect(draftMachineCatalogsKnown(machines, new Set(["a"]))).toBe(false);
  expect(draftMachineCatalogsKnown(machines, new Set(["a", "b"]))).toBe(true);
  expect(draftMachineCatalogsKnown([], new Set())).toBe(true);
});
