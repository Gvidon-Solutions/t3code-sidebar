import { expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import { MachineTag } from "../components/workspaces/MachineTag";
import { useMeshLayout } from "./useMeshLayout";

function Probe() {
  const mesh = useMeshLayout();
  return <div data-testid="probe">{mesh.config === null ? "no mesh config" : "mesh config"}</div>;
}

it("reports a missing mesh provider instead of silently rendering as single-machine", async () => {
  await expect(render(<Probe />)).rejects.toThrow("MeshLayoutProvider is missing");
});

it("still renders an unknown machine tag without inventing a label", async () => {
  await using screen = await render(
    <MachineTag machine={{ label: "Unnamed machine", tag: "", color: "#6d8cff" }} />,
  );
  expect(screen.container.querySelector('[role="img"]')).toBeNull();
  expect(screen.container.textContent).not.toContain("?");
});
