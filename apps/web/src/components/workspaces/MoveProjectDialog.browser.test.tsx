import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { MoveProjectDialog } from "./MoveProjectDialog";

it("searches by project or machine and chooses the target", async () => {
  const projects = [
    { id: "one", environmentId: "gv", title: "Alpha" },
    { id: "two", environmentId: "op", title: "Beta" },
  ];
  const onSelect = vi.fn();
  await using screen = await render(
    <MoveProjectDialog
      projects={projects}
      label={(project) => project.title + " · " + project.environmentId}
      onSelect={onSelect}
      onClose={() => undefined}
    />,
  );
  await screen.getByRole("textbox", { name: "Search projects" }).fill("op");
  await expect.element(screen.getByRole("button", { name: "Alpha · gv" })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Beta · op" }).click();
  expect(onSelect).toHaveBeenCalledWith(projects[1]);
});
