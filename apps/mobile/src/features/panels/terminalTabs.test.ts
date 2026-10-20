import { describe, expect, it } from "vite-plus/test";

import { mergeTerminalTabIds, terminalIdFromTabKey, terminalTabKey } from "./terminalTabs";

describe("terminal tab keys", () => {
  it("round-trips a terminal id and rejects file paths", () => {
    expect(terminalIdFromTabKey(terminalTabKey("term-2"))).toBe("term-2");
    expect(terminalIdFromTabKey("src/terminal:1.ts")).toBeNull();
    expect(terminalIdFromTabKey(null)).toBeNull();
  });
});

describe("mergeTerminalTabIds", () => {
  it("keeps the server order and appends shells it has not listed yet", () => {
    expect(mergeTerminalTabIds(["default", "term-2"], ["term-3", "term-2"])).toEqual([
      "default",
      "term-2",
      "term-3",
    ]);
  });
});
