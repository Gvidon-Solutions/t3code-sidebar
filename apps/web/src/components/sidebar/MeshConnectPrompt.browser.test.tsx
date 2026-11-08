import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { MeshConnectPrompt, MESH_CONNECT_PROMPT_DISMISSED_KEY } from "./MeshConnectPrompt";

const run = vi.fn(async () => ({ _tag: "Success", value: undefined }));

vi.mock(import("../../hooks/useSettings"), () => ({
  usePrimarySettings: (() => true) as never,
}));
vi.mock(import("../../hooks/useMeshOverview"), () => ({
  useMeshOverview: (() => ({
    machines: [
      { environmentId: "studio", label: "studio" },
      { environmentId: "cloudbox", label: "cloudbox" },
    ],
  })) as never,
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironments: (() => ({
    environments: [
      { environmentId: "studio", connection: { phase: "connected" } },
      { environmentId: "cloudbox", connection: { phase: "disconnected" } },
    ],
  })) as never,
}));
vi.mock(import("../../connection/catalog"), () => ({
  environmentCatalog: {
    catalogValueAtom: Atom.make({
      isReady: true,
      entries: new Map([["cloudbox", { enabled: false }]]),
    }),
  } as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => run) as never,
}));

it("offers one action that reconnects every saved mesh machine, and can be dismissed", async () => {
  window.localStorage.removeItem(MESH_CONNECT_PROMPT_DISMISSED_KEY);
  await using screen = await render(<MeshConnectPrompt config={null} />);
  const connect = screen.getByRole("button", { name: "Connect all" });
  await expect.element(connect).toBeVisible();
  await userEvent.click(connect);
  expect(run).toHaveBeenCalledWith({ environmentId: "cloudbox", enabled: true });
  await expect.element(connect).not.toBeInTheDocument();
});
