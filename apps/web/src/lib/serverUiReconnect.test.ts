import { describe, expect, it, vi } from "vite-plus/test";
import { isChunkLoadFailure, serverUiLabel } from "./serverUiReconnect";

describe("isChunkLoadFailure", () => {
  it("recognizes the failures a server restart produces", () => {
    expect(
      isChunkLoadFailure(
        new TypeError("Failed to fetch dynamically imported module: /assets/a.js"),
      ),
    ).toBe(true);
    expect(isChunkLoadFailure(new Error("Unable to preload CSS for /assets/main-1.css"))).toBe(
      true,
    );
    expect(isChunkLoadFailure(new Error("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadFailure("Loading chunk 42 failed.")).toBe(true);
  });

  it("leaves ordinary errors to the boot error page", () => {
    expect(isChunkLoadFailure(new Error("Something else broke"))).toBe(false);
    expect(isChunkLoadFailure(undefined)).toBe(false);
  });

  it("uses the shell's machine name for the reconnecting message", () => {
    vi.stubGlobal("window", { desktopShell: { name: "Studio" } });
    expect(serverUiLabel()).toBe("Studio");
    vi.unstubAllGlobals();
  });
});
