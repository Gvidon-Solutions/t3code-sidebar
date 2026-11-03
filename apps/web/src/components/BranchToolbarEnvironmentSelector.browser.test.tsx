import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { render } from "../../test/render";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";

vi.mock("../hooks/useMeshLayout", () => ({
  useMeshLayout: () => ({
    config: {
      machines: { op: { label: "Operalia", tag: "OP" }, gv: { label: "gvidon", tag: "GV" } },
    },
  }),
}));

it("offers a project copy on another machine and disables an unreachable machine", async () => {
  const onChange = vi.fn();
  await using screen = await render(
    <BranchToolbarEnvironmentSelector
      envLocked={false}
      environmentId={EnvironmentId.make("gv")}
      onEnvironmentChange={onChange}
      availableEnvironments={[
        {
          environmentId: EnvironmentId.make("gv"),
          projectId: ProjectId.make("project"),
          label: "gvidon",
          isPrimary: true,
          machine: "server",
          connected: true,
        },
        {
          environmentId: EnvironmentId.make("op"),
          projectId: null,
          label: "Operalia",
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
  expect(onChange).toHaveBeenCalledWith("op");
});
