import type { ThreadId, UiRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decideUiRequest } from "./uiRequests.ts";

const asking = "thread-asking" as ThreadId;
const request = (target: UiRequest["target"]): UiRequest => ({
  id: "ui-request:1",
  threadId: asking,
  target,
});

describe("decideUiRequest", () => {
  it("switches at once on the device holding the asking thread's voice", () => {
    expect(
      decideUiRequest({
        request: request({ kind: "inbox" }),
        voiceThreadId: asking,
        shownThreadId: "thread-other",
      }),
    ).toBe("navigate");
  });

  it("opens files and the diff in the side panel of a device showing the thread", () => {
    for (const target of [{ kind: "file", path: "README.md" }, { kind: "diff" }] as const) {
      expect(
        decideUiRequest({ request: request(target), voiceThreadId: null, shownThreadId: asking }),
      ).toBe("panel");
    }
  });

  it("only offers to leave the thread the owner is looking at", () => {
    expect(
      decideUiRequest({
        request: request({ kind: "thread", threadId: "thread-other" as ThreadId }),
        voiceThreadId: null,
        shownThreadId: asking,
      }),
    ).toBe("offer");
  });

  it("ignores requests from threads not in front of the owner", () => {
    expect(
      decideUiRequest({
        request: request({ kind: "file", path: "README.md" }),
        voiceThreadId: "thread-other",
        shownThreadId: "thread-other",
      }),
    ).toBe("ignore");
  });
});
