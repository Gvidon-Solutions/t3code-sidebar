import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG, EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { FileMachineTag } from "./FileMachineTag";
import { RightPanelTabs, type RightPanelTabsProps } from "../RightPanelTabs";

vi.mock(import("../../hooks/useMeshLayout"), () => ({
  useMeshLayout: (() => ({
    config: {
      ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
      machines: { remote: { label: "Build machine", tag: "BLD" } },
    },
  })) as never,
  useMeshLayoutOptional: (() => ({
    config: {
      ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
      machines: { remote: { label: "Build machine", tag: "BLD" } },
    },
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [] })) as never,
}));

it("shows the remote machine in the actual file tab and removes it when the thread moves to that machine", async () => {
  const noop = () => {};
  const props: RightPanelTabsProps = {
    mode: "inline",
    environmentId: EnvironmentId.make("local"),
    surfaces: [
      {
        id: "file:remote:README.md",
        kind: "file",
        relativePath: "README.md",
        environmentId: "remote",
        revealLine: null,
        revealRequestId: 0,
      },
    ],
    activeSurfaceId: "file:remote:README.md",
    pendingSurfaceIds: new Set(),
    keybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
    }),
    previewSessions: {},
    desktopByTabId: {},
    terminalLabelsById: new Map(),
    onActivate: noop,
    onCloseSurface: noop,
    onCloseOtherSurfaces: noop,
    onCloseSurfacesToRight: noop,
    onCloseAllSurfaces: noop,
    onCopyFilePath: noop,
    onAddBrowser: noop,
    onAddBrowserInProfile: noop,
    onAddTerminal: noop,
    onAddDiff: noop,
    onAddFiles: noop,
    onAddPullRequest: noop,
    onAddPullRequests: noop,
    onAddDevice: noop,
    browserAvailable: false,
    terminalAvailable: false,
    diffAvailable: false,
    filesAvailable: true,
    pullRequestAvailable: false,
    pullRequestsAvailable: false,
    deviceAvailable: false,
    children: <div>File contents</div>,
  };
  await using screen = await render(<RightPanelTabs {...props} />);
  await expect.element(screen.getByRole("img", { name: "Machine: Build machine" })).toBeVisible();
  expect(
    screen.container.querySelector(
      '[data-active-tab="true"] [aria-label="Machine: Build machine"]',
    ),
  ).not.toBeNull();
  await screen.rerender(<RightPanelTabs {...props} environmentId={EnvironmentId.make("remote")} />);
  await expect
    .element(screen.getByRole("img", { name: "Machine: Build machine" }))
    .not.toBeInTheDocument();
});

it("identifies a remote file using its configured machine and hides the tag for local files", async () => {
  await using screen = await render(
    <FileMachineTag fileEnvironmentId="remote" threadEnvironmentId="local" />,
  );
  await expect
    .element(screen.getByRole("img", { name: "Machine: Build machine" }))
    .toHaveTextContent("BLD");
  await screen.rerender(<FileMachineTag fileEnvironmentId="remote" threadEnvironmentId="remote" />);
  await expect.element(screen.getByRole("img")).not.toBeInTheDocument();
  await screen.rerender(
    <FileMachineTag fileEnvironmentId={undefined} threadEnvironmentId="local" />,
  );
  await expect.element(screen.getByRole("img")).not.toBeInTheDocument();
});
