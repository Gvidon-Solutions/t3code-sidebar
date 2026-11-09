import { describe, expect, it } from "@effect/vitest";

import { projectThreadContentPresentation } from "./threadContentPresentation";

const base = {
  hasDetail: false,
  detailError: null,
  detailDeleted: false,
  machineLabel: "laptop",
  reconnectWindowElapsed: true,
  onRetry: () => {},
} as const;

describe("thread content presentation", () => {
  it("renders cached detail while its environment reconnects", () => {
    expect(
      projectThreadContentPresentation({
        ...base,
        hasDetail: true,
        connectionState: "reconnecting",
      }),
    ).toEqual({ kind: "ready" });
  });

  it("keeps loading during the reconnect window", () => {
    expect(
      projectThreadContentPresentation({
        ...base,
        reconnectWindowElapsed: false,
        connectionState: "reconnecting",
      }),
    ).toEqual({ kind: "loading" });
  });

  it("names the offline machine and offers a retry once the window passes", () => {
    expect(projectThreadContentPresentation({ ...base, connectionState: "reconnecting" })).toEqual({
      kind: "unavailable",
      title: "laptop is offline",
      detail:
        "This conversation lives on laptop, which is offline. It appears here when laptop is back.",
      onRetry: base.onRetry,
    });
  });
});
