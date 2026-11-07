import type { DesktopUiInfo } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, render, stubGlobal } from "../../../test/render";
import { DesktopUiVersionRow } from "./DesktopUiVersionRow";
import { APP_VERSION } from "../../branding";

vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ title, description }: { title: string; description: string }) => (
    <section>
      <h2>{title}</h2>
      <p>{description}</p>
    </section>
  ),
}));

it("reads actual UI, shell and server source versions from the asynchronous desktop bridge", async () => {
  let resolveSource!: (info: DesktopUiInfo) => void;
  const pending = new Promise<DesktopUiInfo>((resolve) => {
    resolveSource = resolve;
  });
  const cloudbox: DesktopUiInfo = {
    source: "server",
    origin: "https://cloudbox.example/",
    environmentId: EnvironmentId.make("cloudbox"),
    version: "server-2",
    shellVersion: "shell-1",
    reason: null,
  };
  using _bridge = stubGlobal("desktopBridge", { ui: { getInfo: () => pending } });
  await using screen = await render(<DesktopUiVersionRow />);
  expect(screen.container.textContent).toBe("");
  await act(() => resolveSource(cloudbox));
  await expect.element(screen.getByText(`UI ${APP_VERSION} · shell shell-1`)).toBeVisible();
  await expect
    .element(screen.getByText("https://cloudbox.example/ · server server-2"))
    .toBeVisible();
});
