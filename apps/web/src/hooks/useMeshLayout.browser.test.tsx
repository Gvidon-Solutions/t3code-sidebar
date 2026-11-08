import { expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import "../index.css";
import { MachineTag } from "../components/workspaces/MachineTag";
import { useMeshLayout } from "./useMeshLayout";

function Probe() {
  const mesh = useMeshLayout();
  return <div data-testid="probe">{mesh.config === null ? "no mesh config" : "mesh config"}</div>;
}

it("renders mesh-aware components without a provider instead of throwing", async () => {
  await using screen = await render(
    <div>
      <Probe />
      <MachineTag machine={{ label: "Unnamed machine", tag: "", color: "#6d8cff" }} />
    </div>,
  );
  await expect.element(screen.getByTestId("probe")).toHaveTextContent("no mesh config");
  // An unknown machine shows nothing at all rather than a "?" tag.
  expect(screen.container.querySelector('[role="img"]')).toBeNull();
  expect(screen.container.textContent).not.toContain("?");
});
