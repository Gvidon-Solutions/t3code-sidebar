import type { CSSProperties, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { buildMeshMachines, type MeshMachine } from "@t3tools/client-runtime/state/mesh-machines";

const mocks = vi.hoisted(() => ({
  openSettings: vi.fn(),
  machines: [] as ReadonlyArray<MeshMachine>,
  meshEnabled: true as boolean | undefined,
}));

vi.mock("react-native", () => ({
  View: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children, style }: { children?: ReactNode; style?: CSSProperties }) => (
    <span style={style}>{children}</span>
  ),
}));
vi.mock("../../lib/clock", () => ({
  useNowMinuteMs: () => Date.parse("2026-11-03T00:00:00.000Z"),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        serverConfig: {
          settings: {
            meshEnabled: mocks.meshEnabled,
            linkedEnvironmentsEnabled: true,
          },
        },
      },
    ],
  }),
}));
vi.mock("../settings/settings-navigation", () => ({ openSettings: mocks.openSettings }));
vi.mock("./useMeshLayout", () => ({ useMeshLayout: () => ({ config: null }) }));
vi.mock("./useMeshOverview", () => ({ useMeshOverview: () => ({ machines: mocks.machines }) }));

import { MeshFooterStatus } from "./MeshFooterStatus";

const namedConfig = {
  ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  machines: { boreal: { label: "Boreal", tag: "BO", color: "#123456", aliases: [] } },
};

const syncedMachines = buildMeshMachines({
  config: DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  connections: [{ environmentId: "studio", label: "Studio", connected: true }],
});

const failingMachines = buildMeshMachines({
  config: namedConfig,
  connections: [{ environmentId: "atlas", label: "Atlas", connected: true }],
  peerStates: [
    {
      environmentId: "boreal",
      lastExchangeAt: "2026-11-02T23:55:00.000Z",
      lastError: "unreachable",
      sentSeq: 0,
      receivedSeq: 0,
    },
  ],
});

async function renderStatus() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<MeshFooterStatus />));
  return {
    container,
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("stays hidden while the mesh is in sync", async () => {
  mocks.meshEnabled = true;
  mocks.machines = syncedMachines;
  const screen = await renderStatus();
  try {
    expect(screen.container.querySelector("button")).toBeNull();
  } finally {
    await screen.dispose();
  }
});

it("shows the compact line only when a machine needs attention", async () => {
  mocks.meshEnabled = true;
  mocks.machines = failingMachines;
  const screen = await renderStatus();
  try {
    const button = screen.container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Boreal is offline · 5 min");
    expect(button?.textContent).toContain("Boreal is offline · 5 min");
  } finally {
    await screen.dispose();
  }
});

it("opens the mesh settings when the warning line is pressed", async () => {
  mocks.meshEnabled = true;
  mocks.machines = failingMachines;
  const screen = await renderStatus();
  try {
    await act(async () => screen.container.querySelector("button")?.click());
    expect(mocks.openSettings).toHaveBeenCalledWith(expect.anything(), "SettingsMesh");
  } finally {
    await screen.dispose();
  }
});

it("treats an absent meshEnabled flag as on, for servers older than the flag", async () => {
  mocks.meshEnabled = undefined;
  mocks.machines = failingMachines;
  const screen = await renderStatus();
  try {
    expect(screen.container.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Boreal is offline · 5 min",
    );
  } finally {
    await screen.dispose();
  }
});
