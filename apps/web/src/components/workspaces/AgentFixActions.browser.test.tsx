import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { AgentFixActions } from "./AgentFixActions";

const prompt = "Fix the mesh. Machines: Studio (online).";

it("opens a prepared thread and offers a copy fallback", async () => {
  const writeText = vi.fn(async () => undefined);
  const clipboard = vi.spyOn(navigator, "clipboard", "get").mockReturnValue({
    writeText,
  } as unknown as Clipboard);
  await using screen = await render(<AgentFixActions prompt={prompt} />, {
    router: "/settings/mesh",
  });
  await screen.getByRole("button", { name: "Copy prompt", exact: true }).click();
  expect(writeText).toHaveBeenCalledWith(prompt);
  const router = screen.router;
  await screen.getByRole("button", { name: "Fix with an agent", exact: true }).click();
  await vi.waitFor(() => {
    expect(router?.state.location.pathname).toBe("/new");
    expect(new URLSearchParams(router?.state.location.searchStr).get("prompt")).toBe(prompt);
  });
  clipboard.mockRestore();
});
