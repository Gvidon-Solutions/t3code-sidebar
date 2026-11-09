import type { SidebarWorkspacesConfig } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import { ProjectMachineDescription } from "./CommandPaletteProjectItems";

it("shows project machine tags with names only in the tooltip", async () => {
  const config = {
    machines: {
      studio: { title: "studio", tag: "ST" },
      laptop: { title: "laptop", tag: "LT" },
    },
    projectMounts: {
      atlas: [
        {
          environmentId: "studio",
          path: "/data/atlas",
          projectId: "atlas",
          transport: "git",
          role: "primary",
          createdAt: "",
        },
        {
          environmentId: "laptop",
          path: "/data/atlas",
          projectId: "atlas",
          transport: "mutagen",
          role: "replica",
          createdAt: "",
        },
      ],
    },
    projectMountStatus: {},
  } as unknown as SidebarWorkspacesConfig;
  await using screen = await render(
    <ProjectMachineDescription
      config={config}
      group={
        {
          projectKey: "atlas",
          memberProjects: [
            { environmentId: "studio", id: "atlas" },
            { environmentId: "laptop", id: "atlas" },
          ],
        } as never
      }
      project={
        {
          environmentId: "studio",
          id: "atlas",
          title: "Atlas",
          displayName: "Atlas",
          workspaceRoot: "/data/atlas",
        } as never
      }
    />,
    { router: false },
  );
  await expect.element(screen.getByText("ST")).toBeVisible();
  await expect.element(screen.getByText("LT")).toBeVisible();
  expect(screen.container.textContent).not.toContain("studio · laptop");
  const description = screen.container.querySelector('[aria-label="On studio · laptop"]');
  expect(description).not.toBeNull();
  expect(description!.textContent).toBe("STLT");
});
