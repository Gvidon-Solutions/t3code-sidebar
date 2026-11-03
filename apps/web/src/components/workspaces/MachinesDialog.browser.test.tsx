import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG, type SidebarProjectMount } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { MachinesDialog } from "./MachinesDialog";
import "../../index.css";

it("confirms the actual primary or replica being removed, with cancellation preserving it", async () => {
  const remove = vi.fn();
  const rep: SidebarProjectMount = {
    environmentId: "qa",
    path: "/work/qa",
    projectId: "qa-project",
    transport: "git",
    role: "primary",
    createdAt: "",
  };
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    title: "QA project",
    logicalKey: "qa",
    machines: [{ environmentId: "qa", label: "QA machine", disabled: false, reason: null }],
    liveStatuses: [],
    onAddReplica: vi.fn(),
    onMakePrimary: vi.fn(),
    onRemove: remove,
    onRetry: vi.fn(),
  };
  const config = { ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG, projectMounts: { qa: [rep] } };
  await using screen = await render(<MachinesDialog {...props} config={config} />);
  await expect.element(page.getByText("QA machine", { exact: true })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Remove", exact: true }));
  await expect.element(page.getByText("Remove this primary?", { exact: true })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
  await expect
    .element(page.getByText("Remove this primary?", { exact: true }))
    .not.toBeInTheDocument();
  expect(remove).not.toHaveBeenCalled();
  await screen.rerender(
    <MachinesDialog
      {...props}
      config={{
        ...config,
        projectMounts: {
          qa: [{ ...rep, role: "replica", transport: "mutagen", source: "source" }],
        },
      }}
    />,
  );
  await userEvent.click(page.getByRole("button", { name: "Remove", exact: true }));
  await expect.element(page.getByText("Remove this replica?", { exact: true })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
  await expect
    .element(page.getByText("Remove this replica?", { exact: true }))
    .not.toBeInTheDocument();
  expect(remove).not.toHaveBeenCalled();
});
