import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { MeshConnectPrompt, MESH_CONNECT_PROMPT_DISMISSED_KEY } from "./MeshConnectPrompt";

const mocks = vi.hoisted(() => ({
  machines: [
    { environmentId: "studio", label: "studio" },
    { environmentId: "cloudbox", label: "cloudbox" },
  ] as ReadonlyArray<{ environmentId: string; label: string }>,
}));

const run = vi.fn(async () => ({ _tag: "Success", value: undefined }));
const success = async () => ({ _tag: "Success", value: undefined });

vi.mock(import("../../hooks/useSettings"), () => ({
  usePrimarySettings: (() => true) as never,
}));
vi.mock(import("../../hooks/useMeshOverview"), () => ({
  useMeshOverview: (() => ({ machines: mocks.machines })) as never,
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

function readDismissed(): unknown {
  return JSON.parse(window.localStorage.getItem(MESH_CONNECT_PROMPT_DISMISSED_KEY) ?? "[]");
}

it("offers one action that reconnects every saved mesh machine, and can be dismissed", async () => {
  run.mockImplementation(success);
  mocks.machines = [
    { environmentId: "studio", label: "studio" },
    { environmentId: "cloudbox", label: "cloudbox" },
  ];
  window.localStorage.removeItem(MESH_CONNECT_PROMPT_DISMISSED_KEY);
  await using screen = await render(<MeshConnectPrompt config={null} />);
  const connect = screen.getByRole("button", { name: "Connect all" });
  await expect.element(connect).toBeVisible();
  await userEvent.click(connect);
  expect(run).toHaveBeenCalledWith({ environmentId: "cloudbox", enabled: true });
  await expect.element(connect).not.toBeInTheDocument();
});

it("runs the reconnect sequence only once for a double tap", async () => {
  let settle: (value: { _tag: "Success"; value: undefined }) => void = () => undefined;
  run.mockImplementation(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  mocks.machines = [
    { environmentId: "studio", label: "studio" },
    { environmentId: "cloudbox", label: "cloudbox" },
  ];
  window.localStorage.removeItem(MESH_CONNECT_PROMPT_DISMISSED_KEY);
  await using screen = await render(<MeshConnectPrompt config={null} />);
  const connect = screen.container.querySelector(
    "[data-mesh-connect-prompt] button",
  ) as HTMLButtonElement;
  await act(() => {
    connect.click();
    connect.click();
  });
  expect(run).toHaveBeenCalledTimes(1);
  settle({ _tag: "Success", value: undefined });
  run.mockImplementation(success);
});

it("merges a dismissal made meanwhile instead of overwriting it", async () => {
  run.mockImplementation(success);
  mocks.machines = [
    { environmentId: "studio", label: "studio" },
    { environmentId: "cloudbox", label: "cloudbox" },
  ];
  window.localStorage.removeItem(MESH_CONNECT_PROMPT_DISMISSED_KEY);
  await using screen = await render(<MeshConnectPrompt config={null} />);
  window.localStorage.setItem(MESH_CONNECT_PROMPT_DISMISSED_KEY, JSON.stringify(["studio"]));
  await userEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(readDismissed()).toEqual(["cloudbox", "studio"]);
});

it("does not dismiss a machine this device never added", async () => {
  run.mockImplementation(success);
  mocks.machines = [
    { environmentId: "studio", label: "studio" },
    { environmentId: "cloudbox", label: "cloudbox" },
    { environmentId: "laptop", label: "laptop" },
  ];
  window.localStorage.removeItem(MESH_CONNECT_PROMPT_DISMISSED_KEY);
  await using screen = await render(<MeshConnectPrompt config={null} />);
  await userEvent.click(screen.getByRole("button", { name: "Connect all" }));
  expect(readDismissed()).toEqual(["cloudbox"]);
});
