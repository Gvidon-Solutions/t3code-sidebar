import { describe, expect, it } from "vite-plus/test";
import { defaultDraftMachine } from "./draftMachine.ts";

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
  ).toBe("Provider unauthenticated");
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

import { DraftMachineSendQueue } from "./draftMachine.ts";

it("retains a send through mounting and retry, then dispatches once with the registered destination", () => {
  const queue = new DraftMachineSendQueue();
  const draft = { text: "Keep this message", attachments: ["image.png"], machine: "primary" };
  const sent: (typeof draft)[] = [];
  const send = () => sent.push({ ...draft });
  expect(queue.defer(true)).toBe(true);
  queue.resume(true, send);
  expect(sent).toEqual([]);
  queue.defer(true);
  queue.resume(true, send);
  expect(draft.text).toBe("Keep this message");
  draft.machine = "registered-replica";
  queue.resume(false, send);
  queue.resume(false, send);
  expect(sent).toEqual([
    { text: "Keep this message", attachments: ["image.png"], machine: "registered-replica" },
  ]);
  expect(queue.defer(false)).toBe(false);
});
