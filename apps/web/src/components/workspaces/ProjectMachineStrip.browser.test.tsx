import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG as empty } from "@t3tools/contracts";
import { projectMachineStrip } from "@t3tools/client-runtime/state/mesh-layout";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { ProjectMachineStrip } from "./ProjectMachineStrip";

it("opens Machines without toggling its folder, including after a live status changes", async () => {
  const open = vi.fn();
  const toggle = vi.fn();
  const config = {
    ...empty,
    projectMounts: {
      demo: [
        {
          environmentId: "gv",
          role: "replica" as const,
          path: "/demo",
          transport: "mutagen" as const,
          createdAt: "",
        },
      ],
    },
  };
  const group = { projectKey: "demo", environmentIds: ["gv"], knownEnvironmentIds: ["gor", "gv"] };
  const model = projectMachineStrip(config, group, []);
  await using screen = await render(
    <div onClick={toggle}>
      <ProjectMachineStrip model={model} onOpen={open} />
    </div>,
  );
  await screen.getByRole("button", { name: "Replica on gv (pending)" }).click();
  expect(open).toHaveBeenCalledOnce();
  expect(toggle).not.toHaveBeenCalled();
  const synced = projectMachineStrip(config, group, [
    {
      logicalKey: "demo",
      environmentId: "gv",
      state: "watching",
      conflicts: [],
      problems: [],
      updatedAt: "",
    },
  ]);
  await screen.rerender(
    <div onClick={toggle}>
      <ProjectMachineStrip model={synced} onOpen={open} />
    </div>,
  );
  await expect
    .element(screen.getByRole("button", { name: "Replica on gv (synced)" }))
    .toBeVisible();
});
