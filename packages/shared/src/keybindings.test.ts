import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_KEYBINDINGS } from "./keybindings.ts";

describe("default keybindings", () => {
  it("binds composer.cycleHost without shadowing another default", () => {
    const cycle = DEFAULT_KEYBINDINGS.find((rule) => rule.command === "composer.cycleHost");
    expect(cycle).toEqual({
      key: "mod+alt+h",
      command: "composer.cycleHost",
      when: "!terminalFocus",
    });
    const conflicts = DEFAULT_KEYBINDINGS.filter(
      (rule) => rule !== cycle && rule.key === cycle!.key,
    );
    expect(conflicts).toEqual([]);
  });
});
