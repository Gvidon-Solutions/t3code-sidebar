import type { EnvironmentId, ThreadId, UiRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decideUiRequest, uiTargetEnvironmentId } from "./uiRequests.ts";

const asking = "thread-asking" as ThreadId;
const here = "env-here" as EnvironmentId;
const there = "env-there" as EnvironmentId;
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

  it("switches at once on the device showing the asking thread", () => {
    expect(
      decideUiRequest({
        request: request({ kind: "thread", threadId: "thread-other" as ThreadId }),
        voiceThreadId: null,
        shownThreadId: asking,
      }),
    ).toBe("navigate");
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

describe("uiTargetEnvironmentId", () => {
  it("follows a thread or file named on another machine", () => {
    expect(
      uiTargetEnvironmentId(
        { kind: "thread", threadId: "thread-there" as ThreadId, environmentId: there },
        here,
      ),
    ).toBe(there);
    expect(
      uiTargetEnvironmentId(
        { kind: "file", path: "/srv/app/README.md", environmentId: there },
        here,
      ),
    ).toBe(there);
  });

  it("defaults to the asking thread's machine", () => {
    expect(
      uiTargetEnvironmentId({ kind: "thread", threadId: "thread-here" as ThreadId }, here),
    ).toBe(here);
    expect(uiTargetEnvironmentId({ kind: "file", path: "README.md" }, here)).toBe(here);
    expect(uiTargetEnvironmentId({ kind: "home" }, here)).toBe(here);
    expect(uiTargetEnvironmentId({ kind: "diff" }, here)).toBe(here);
    expect(uiTargetEnvironmentId({ kind: "inbox" }, here)).toBe(here);
    expect(uiTargetEnvironmentId({ kind: "workspace", workspace: "main" }, here)).toBe(here);
  });
});
