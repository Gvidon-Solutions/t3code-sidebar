import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { MeshFooterStatus } from "./MeshFooterStatus";

vi.mock(import("../../hooks/useSettings"), () => ({ usePrimarySettings: (() => true) as never }));
vi.mock(import("../../hooks/useNowMinute"), () => ({ useNowMinute: () => "2026-11-03T00:00:00Z" }));
vi.mock(import("../../hooks/useMeshOverview"), () => ({
  useMeshOverview: (() => ({
    machines: [
      {
        environmentId: "qa",
        label: "QA",
        lastError: null,
        lastLayoutSyncAt: "2026-11-03T00:00:00Z",
      },
    ],
  })) as never,
}));

it("opens Mesh settings from its named keyboard-focusable status link", async () => {
  await using screen = await render(<MeshFooterStatus config={null} />);
  const link = screen.getByRole("link", { name: "Open mesh settings" });
  await expect.element(link).toBeVisible();
  await userEvent.tab();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Open mesh settings");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/settings/mesh"));
});
