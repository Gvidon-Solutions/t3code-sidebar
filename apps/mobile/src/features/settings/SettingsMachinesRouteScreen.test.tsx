vi.mock("../../components/ui/Sheet", () => ({
  Sheet: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../state/meshReplicas", () => ({ useReplicaStatuses: () => [] }));
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
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
vi.mock("./MeshConfigSheet", () => ({ MeshConfigSheet: () => <div>Mesh YAML editor</div> }));
vi.mock("../../state/mesh-layout", () => ({ meshLayoutAtoms: { configStatus: () => null } }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null, error: null }) }));
vi.mock("../workspaces/useMeshLayout", () => ({
  useMeshLayout: () => ({ source: "studio", config: DEFAULT_SIDEBAR_WORKSPACES_CONFIG }),
}));
vi.mock("../workspaces/useMeshOverview", () => ({
  useMeshOverview: () => ({
    machines: buildMeshMachines({
      config: {
        ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
        machines: { studio: { title: "Studio" }, cloudbox: { title: "Studio" } },
      },
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

it("shows state and opens editing and pairing without machine settings fields", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<SettingsMachinesRouteScreen />));
    expect(container.textContent).toContain("2 machines · 2 online");
    expect(container.textContent).toContain("1.0");
    expect(container.textContent).toContain("Studio (linux · desk:3795)");
    expect(container.textContent).toContain("Studio (darwin · laptop:3795)");
    expect(container.querySelector("input")).toBeNull();
    act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Edit config")!
        .click(),
    );
    expect(container.textContent).toContain("Mesh YAML editor");
    act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Link a machine")!
        .click(),
    );
    expect(container.textContent).toContain("Pairing code");
  } finally {
    act(() => root.unmount());
  }
});
