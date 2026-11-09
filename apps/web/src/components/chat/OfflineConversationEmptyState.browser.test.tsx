import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { OfflineConversationEmptyState } from "./OfflineConversationEmptyState";

it("says where an unsaved conversation lives and retries", async () => {
  const onRetry = vi.fn();
  await using screen = await render(
    <OfflineConversationEmptyState machineLabel="laptop" onRetry={onRetry} />,
    { router: false },
  );
  await expect
    .element(
      screen.getByText(
        "This conversation lives on laptop, which is offline. It appears here when laptop is back.",
      ),
    )
    .toBeVisible();
  await screen.getByRole("button", { name: "Retry" }).click();
  expect(onRetry).toHaveBeenCalledTimes(1);
});
