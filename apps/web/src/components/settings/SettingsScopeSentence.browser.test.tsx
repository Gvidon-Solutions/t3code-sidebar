import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { SettingsScopeSentence } from "./SettingsScopeSentence";

vi.mock(import("../../state/environments"), () => ({
  useEnvironments: (() => ({ environments: [] })) as never,
}));
vi.mock(import("./SettingsScopeContext"), () => ({
  useOptionalSettingsScope: (() => ({
    search: {},
    singleEnvironment: false,
    groups: [],
    scope: { kind: "all" },
    selectScope: () => {},
  })) as never,
}));

it("shows scope controls for provider settings but omits them on both mesh routes", async () => {
  await using screen = await render(<SettingsScopeSentence />, { router: "/settings/providers" });
  await expect.element(screen.getByText("Applying settings for")).toBeVisible();
  await screen.router?.navigate({ to: "/settings/mesh" });
  await expect.element(screen.getByText("Applying settings for")).not.toBeInTheDocument();
  await screen.router?.navigate({ to: "/settings/machines" });
  await expect.element(screen.getByText("Applying settings for")).not.toBeInTheDocument();
});
