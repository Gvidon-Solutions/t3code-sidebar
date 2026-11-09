import { describe, expect, it } from "vite-plus/test";

import { connectionFloatingStatus } from "./floating-working-status";

function labelOf(status: ReturnType<typeof connectionFloatingStatus>): string {
  if (status === null || status.kind !== "connection")
    throw new Error("expected connection status");
  return status.label;
}

describe("connectionFloatingStatus", () => {
  it("names the configured machine and says the saved conversation is showing", () => {
    expect(
      labelOf(
        connectionFloatingStatus({
          connectionError: "did not answer",
          connectionState: "error",
          environmentLabel: "laptop",
          hasCachedConversation: true,
          onReconnect: () => undefined,
        }),
      ),
    ).toBe("laptop is offline · showing the last saved conversation");
  });

  it("offers a retry when nothing was cached", () => {
    expect(
      labelOf(
        connectionFloatingStatus({
          connectionError: null,
          connectionState: "error",
          environmentLabel: "laptop",
          hasCachedConversation: false,
          onReconnect: () => undefined,
        }),
      ),
    ).toBe("laptop is offline · Retry");
  });
});

it("stops saying reconnecting once the reconnect window has passed", () => {
  expect(
    labelOf(
      connectionFloatingStatus({
        connectionError: null,
        connectionState: "reconnecting",
        environmentLabel: "laptop",
        hasCachedConversation: false,
        reconnectWindowElapsed: true,
        onReconnect: () => undefined,
      }),
    ),
  ).toBe("laptop is offline · Retry");
  expect(
    labelOf(
      connectionFloatingStatus({
        connectionError: null,
        connectionState: "reconnecting",
        environmentLabel: "laptop",
        hasCachedConversation: false,
        reconnectWindowElapsed: false,
        onReconnect: () => undefined,
      }),
    ),
  ).toBe("Reconnecting to laptop...");
});

it("yields to the centred offline conversation pane", () => {
  expect(
    connectionFloatingStatus({
      connectionError: null,
      connectionState: "error",
      environmentLabel: "laptop",
      hasCachedConversation: false,
      reconnectWindowElapsed: true,
      offlinePaneVisible: true,
      onReconnect: () => undefined,
    }),
  ).toBeNull();
  expect(
    labelOf(
      connectionFloatingStatus({
        connectionError: null,
        connectionState: "error",
        environmentLabel: "laptop",
        hasCachedConversation: true,
        reconnectWindowElapsed: true,
        offlinePaneVisible: false,
        onReconnect: () => undefined,
      }),
    ),
  ).toBe("laptop is offline · showing the last saved conversation");
});
