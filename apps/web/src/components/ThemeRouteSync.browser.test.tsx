import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { ThemeRouteSync } from "./ThemeRouteSync";

it("applies the system appearance on a pre-auth page whose boot appearance is stale", async () => {
  localStorage.clear();
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  }));
  document.documentElement.classList.add("dark");
  await using _screen = await render(<ThemeRouteSync />, { router: false });
  await vi.waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(false));
  vi.unstubAllGlobals();
});
