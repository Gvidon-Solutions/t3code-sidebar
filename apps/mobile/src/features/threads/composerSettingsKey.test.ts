import { describe, expect, it } from "vite-plus/test";

import { resolveComposerSettingsKey } from "./composerSettingsKey";

describe("composer settings key", () => {
  it("writes a new-task draft's settings to the flow draft, not the synthetic thread", () => {
    expect(
      resolveComposerSettingsKey({
        isDraft: true,
        draftKey: "draft-task:abc",
        threadKey: "env-1:thread-1",
      }),
    ).toBe("draft-task:abc");
  });

  it("keeps a real thread's settings on the thread while a queued edit is open", () => {
    expect(
      resolveComposerSettingsKey({
        isDraft: false,
        draftKey: "env-1:thread-1:queued:run-1",
        threadKey: "env-1:thread-1",
      }),
    ).toBe("env-1:thread-1");
  });

  it("falls back to the thread key when a draft has no draft key", () => {
    expect(
      resolveComposerSettingsKey({
        isDraft: true,
        draftKey: undefined,
        threadKey: "env-1:thread-1",
      }),
    ).toBe("env-1:thread-1");
  });
});
