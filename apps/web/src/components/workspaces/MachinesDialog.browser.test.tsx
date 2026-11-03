import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG as empty, EnvironmentId } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { MachinesDialog } from "./MachinesDialog";
import { useOpenFileDialogStore } from "../files/openFileDialogState";

it("opens the preserved versions on the losing machine from the last automatic resolution", async () => {
  const onOpenChange = vi.fn();
  const copies = {
    environmentId: "primary",
    path: "/primary/.t3-conflicts/2026-11-03T00:00:00.000Z/",
  };
  const config = {
    ...empty,
    machines: { replica: { label: "Replica" } },
    projectMounts: {
      project: [
        {
          environmentId: "replica",
          path: "/replica",
          role: "replica",
          transport: "mutagen",
          source: "primary",
          createdAt: "",
        } as const,
      ],
    },
    projectMountStatus: {
      project: {
        replica: {
          state: "watching",
          updatedAt: "",
          message: "Resolved 1 conflicts automatically · copies in .t3-conflicts",
          conflictCopies: copies,
        } as const,
      },
    },
  };
  // This dialog has no route dependency; the action opens the shared file picker.
  await using _screen = await render(
    <MachinesDialog
      open
      onOpenChange={onOpenChange}
      title="Project"
      config={config}
      logicalKey="project"
      machines={[]}
      liveStatuses={[]}
      onAddReplica={vi.fn()}
      onMakePrimary={vi.fn()}
      onRemove={vi.fn()}
      onRetry={vi.fn()}
    />,
    { router: false },
  );
  await expect
    .element(page.getByText("Resolved 1 conflicts automatically · copies in .t3-conflicts"))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Open copies" }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(useOpenFileDialogStore.getState().initialEnvironmentId).toBe(
    EnvironmentId.make("primary"),
  );
  expect(useOpenFileDialogStore.getState().initialPath).toBe(copies.path);
  useOpenFileDialogStore.getState().close();
});
