import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ComposerVoiceToggle } from "./ComposerVoiceToggle";

it("renders the voice toggle in the expanded composer and starts a conversation", async () => {
  const onToggle = vi.fn();
  await using screen = await render(
    <ComposerVoiceToggle
      supported
      engaged={false}
      label="Start voice conversation"
      onToggle={onToggle}
    />,
  );
  const button = screen.getByRole("button", { name: "Start voice conversation" });
  await expect.element(button).toBeVisible();
  await userEvent.click(button);
  expect(onToggle).toHaveBeenCalledOnce();
});

it("renders nothing when the thread provider has no voice", async () => {
  await using screen = await render(
    <ComposerVoiceToggle
      supported={false}
      engaged={false}
      label="Start voice conversation"
      onToggle={() => {}}
    />,
  );
  expect(screen.container.querySelector("button")).toBeNull();
});
