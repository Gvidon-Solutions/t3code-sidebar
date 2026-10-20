import { describe, expect, it } from "vite-plus/test";

import { composerOffersFullScreen } from "./fullScreenLines";

describe("composerOffersFullScreen", () => {
  it("offers the full-screen editor once the draft wraps to three lines", () => {
    expect(composerOffersFullScreen(44, 22)).toBe(false);
    expect(composerOffersFullScreen(65, 22)).toBe(true);
    expect(composerOffersFullScreen(66, 22)).toBe(true);
  });
});
