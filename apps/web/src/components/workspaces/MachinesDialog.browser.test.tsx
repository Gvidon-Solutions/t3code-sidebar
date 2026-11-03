import "../../index.css";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG as empty,
  EnvironmentId,
  type SidebarProjectMount,
} from "@t3tools/contracts";
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
  const config = { ...empty, projectMounts: { qa: [rep] } };
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

it("shows skipped file diagnostics calmly without offering retry for a healthy copy", async () => {
  const rep: SidebarProjectMount = {
    environmentId: "copy",
    path: "/copy",
    role: "replica",
    transport: "mutagen",
    source: "primary",
    projectId: "ready",
    createdAt: "",
  };
  await using _screen = await render(
    <MachinesDialog
      open
      logicalKey="project"
      title="Project"
      config={{
        ...empty,
        projectMounts: { project: [rep] },
        projectMountStatus: {
          project: {
            copy: {
              state: "watching",
              skipped: 1,
              skippedPaths: [{ path: "outside-link", error: "absolute symlink" }],
              message: "1 file skipped (symlinks outside the project)",
              updatedAt: "",
            },
          },
        },
      }}
      machines={[]}
      liveStatuses={[]}
      onOpenChange={vi.fn()}
      onAddReplica={vi.fn()}
      onMakePrimary={vi.fn()}
      onRemove={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  await expect
    .element(page.getByText("1 file skipped (symlinks outside the project)", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("outside-link: absolute symlink", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Retry", exact: true }))
    .not.toBeInTheDocument();
});
