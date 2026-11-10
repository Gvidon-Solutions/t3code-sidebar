import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { render } from "../../test/render";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";

vi.mock("../hooks/useMeshLayout", () => ({
  useMeshLayout: () => ({
    config: {
      machines: { bo: { label: "Boreal", tag: "BO" }, at: { label: "atlas", tag: "AT" } },
    },
  }),
  useMeshLayoutOptional: () => ({
    config: {
      machines: { bo: { label: "Boreal", tag: "BO" }, at: { label: "atlas", tag: "AT" } },
    },
  }),
}));

it("offers a project copy on another machine and disables an unreachable machine", async () => {
  const onChange = vi.fn();
  await using screen = await render(
    <BranchToolbarEnvironmentSelector
      envLocked={false}
      environmentId={EnvironmentId.make("at")}
      onEnvironmentChange={onChange}
      availableEnvironments={[
        {
          environmentId: EnvironmentId.make("at"),
          projectId: ProjectId.make("project"),
          label: "atlas",
          isPrimary: true,
          machine: "server",
          connected: true,
        },
        {
          environmentId: EnvironmentId.make("bo"),
          projectId: null,
          label: "Boreal",
          isPrimary: false,
          machine: "server",
          connected: true,
        },
        {
          environmentId: EnvironmentId.make("offline"),
          projectId: null,
          label: "Offline",
          isPrimary: false,
          machine: "server",
          connected: false,
        },
      ]}
    />,
  );
  await screen.getByRole("combobox").click();
  await expect
    .element(screen.getByRole("option", { name: /Offline/ }))
    .toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(onChange).toHaveBeenCalledWith("bo");
});
