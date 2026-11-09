import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { environmentNameOf } from "@t3tools/client-runtime/state/machine-display";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { EnvironmentRow } from "./EnvironmentRow";

const mesh: SidebarWorkspacesConfig = {
  ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  machines: {
    "env-studio": { title: "studio", tag: "ST" },
    "env-cloudbox": { title: "cloudbox", tag: "CB" },
    "env-laptop": { title: "laptop", tag: "LT" },
  },
};

function Row({
  environmentId,
  config,
}: {
  readonly environmentId: string;
  readonly config: SidebarWorkspacesConfig | null;
}) {
  const name = environmentNameOf(config, environmentId, "shared-host");
  return (
    <EnvironmentRow
      kind="server"
      label={name.label}
      subtitle="Connected"
      {...(name.inMesh ? { machine: name } : {})}
    />
  );
}

it("names three mesh machines that share one host name by tag and title", async () => {
  await using screen = await render(
    <div>
      <Row environmentId="env-studio" config={mesh} />
      <Row environmentId="env-cloudbox" config={mesh} />
      <Row environmentId="env-laptop" config={mesh} />
    </div>,
  );
  const text = screen.container.textContent!;
  for (const value of ["ST", "studio", "CB", "cloudbox", "LT", "laptop"]) {
    expect(text).toContain(value);
  }
  expect(text).not.toContain("shared-host");
});

it("keeps the saved host name, without a tag, outside a mesh", async () => {
  await using screen = await render(<Row environmentId="env-studio" config={null} />);
  expect(screen.container.textContent).toContain("shared-host");
  expect(screen.container.querySelector('[role="img"]')).toBeNull();
});
