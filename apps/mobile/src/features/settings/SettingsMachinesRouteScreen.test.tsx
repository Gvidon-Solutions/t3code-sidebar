const mocks = vi.hoisted(() => ({
  source: "studio" as string | null,
  connectedEnvironmentId: null as string | null,
  document: {} as Record<string, { h: string; v: unknown }>,
  openURL: vi.fn(),
}));

vi.mock("../../components/ui/Sheet", () => ({
  Sheet: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    accessibilityLabel,
    onPress,
    disabled,
  }: {
    label: string;
    accessibilityLabel?: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button aria-label={accessibilityLabel ?? label} disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../state/meshReplicas", () => ({ useReplicaStatuses: () => [] }));
vi.mock("expo-linking", () => ({
  createURL: (path: string, options: { queryParams?: Record<string, string> }) =>
    `${path}?${new URLSearchParams(options.queryParams).toString()}`,
  openURL: mocks.openURL,
}));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { buildMeshMachines } from "@t3tools/client-runtime/state/mesh-machines";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./components/SettingsScreen", () => ({
  SettingsScreen: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ children, title }: { children?: ReactNode; title?: string }) => (
    <section>
      {title}
      {children}
    </section>
  ),
}));
vi.mock("./MeshLinkForm", () => ({ MeshLinkForm: () => <div>Pairing code</div> }));
vi.mock("../../state/mesh-layout", () => ({ meshLayoutAtoms: { configStatus: () => null } }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null, error: null }) }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments:
      mocks.connectedEnvironmentId === null
        ? []
        : [
            {
              environmentId: mocks.connectedEnvironmentId,
              connection: { phase: "connected" },
            },
          ],
  }),
}));
vi.mock("../workspaces/useMeshLayout", () => ({
  useMeshLayout: () => ({
    source: mocks.source,
    config: config(),
    state: { snapshot: { document: mocks.document } },
    edit: vi.fn(),
  }),
}));
vi.mock("../workspaces/useMeshOverview", () => ({
  useMeshOverview: () => ({
    machines: buildMeshMachines({
      config: config(),
      connections: [
        {
          environmentId: "studio",
          label: "Studio",
          connected: true,
          version: "1.0",
          platform: { os: "linux", arch: "x64" },
          urls: ["https://desk.example:3795"],
        },
        {
          environmentId: "cloudbox",
          label: "Studio",
          connected: true,
          platform: { os: "darwin", arch: "arm64" },
          urls: ["https://laptop.example:3795"],
        },
      ],
    }),
    links: [],
  }),
}));
import { SettingsMachinesRouteScreen } from "./SettingsMachinesRouteScreen";

function config(): SidebarWorkspacesConfig {
  return {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    machines: { studio: { title: "Zulu" }, cloudbox: { title: "Alpha" } },
  };
}

function renderScreen() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  return {
    container,
    render() {
      act(() => root.render(<SettingsMachinesRouteScreen />));
    },
    dispose() {
      act(() => root.unmount());
    },
  };
}

it("shows machine state and pairing without machine settings fields", () => {
  mocks.source = "studio";
  mocks.connectedEnvironmentId = "studio";
  mocks.document = {};
  const screen = renderScreen();
  try {
    screen.render();
    expect(screen.container.textContent).toContain("2 machines · 2 online");
    // A phone has no "this machine": rows sort by title, not by the layout source.
    expect(screen.container.textContent).toContain("Alpha");
    expect(screen.container.textContent).toContain("Zulu");
    expect(screen.container.textContent!.indexOf("Alpha")).toBeLessThan(
      screen.container.textContent!.indexOf("Zulu"),
    );
    expect(screen.container.querySelector("input")).toBeNull();
    expect(screen.container.textContent).toContain("Set up the mesh with an agent");
    act(() =>
      [...screen.container.querySelectorAll("button")]
        .find((button) => button.textContent === "Link a machine")!
        .click(),
    );
    expect(screen.container.textContent).toContain("Pairing code");
  } finally {
    screen.dispose();
  }
});

it("shows a failed update with a project-aware agent action", () => {
  mocks.source = "studio";
  mocks.connectedEnvironmentId = "studio";
  mocks.openURL.mockReset();
  mocks.document = {
    "mesh.updateFailure/r7": {
      h: "1",
      v: { environmentId: "studio", reason: "health check failed", target: "0.1.7" },
    },
  };
  const screen = renderScreen();
  try {
    screen.render();
    expect(screen.container.textContent).toContain(
      "Update to 0.1.7 failed on Zulu: health check failed",
    );
    const fix = [...screen.container.querySelectorAll("button")].find(
      (button) =>
        button.getAttribute("aria-label") === "Fix the update failure on Zulu with an agent",
    );
    expect(fix).toBeDefined();
    act(() => fix!.click());
    expect(mocks.openURL).toHaveBeenCalledWith(expect.stringContaining("env=studio"));
  } finally {
    screen.dispose();
  }
});

it("enables setup through a connected machine even when the layout source is unknown", () => {
  mocks.source = null;
  mocks.connectedEnvironmentId = "cloudbox";
  mocks.document = {};
  mocks.openURL.mockReset();
  const screen = renderScreen();
  try {
    screen.render();
    const setup = [...screen.container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Set up the mesh with an agent",
    );
    expect(setup).toBeDefined();
    expect(setup!.disabled).toBe(false);
    act(() => setup!.click());
    expect(mocks.openURL).toHaveBeenCalledWith(expect.stringContaining("env=cloudbox"));
  } finally {
    screen.dispose();
  }
});

it("disables the setup action without any connected machine and explains it", () => {
  mocks.source = null;
  mocks.connectedEnvironmentId = null;
  mocks.document = {};
  const screen = renderScreen();
  try {
    screen.render();
    const setup = [...screen.container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Set up the mesh with an agent",
    );
    expect(setup).toBeDefined();
    expect(setup!.disabled).toBe(true);
    expect(screen.container.textContent).toContain(
      "Connect this phone to a machine to set up the mesh.",
    );
  } finally {
    screen.dispose();
  }
});
