import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  config: null as SidebarWorkspacesConfig | null,
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
  Platform: { OS: "android" },
}));
vi.mock("react-native-reanimated", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    default: { View },
    Animated: { View },
    FadeIn: { duration: () => undefined },
    FadeOut: { duration: () => undefined },
    LinearTransition: { duration: () => undefined },
  };
});
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
}));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/IconButton", () => ({ IconButton: () => null }));
vi.mock("../../components/ui/ThemedSwitch", () => ({ ThemedSwitch: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("./ConnectionStatusDot", () => ({ ConnectionStatusDot: () => null }));
vi.mock("./ConnectionFormField", () => ({ ConnectionFormField: () => null }));
vi.mock("./ConnectionTraceId", () => ({ ConnectionTraceId: () => null }));
vi.mock("./ConnectionDiagnosisDetails", () => ({
  ConnectionDiagnosisDetails: () => null,
  useConnectionDiagnosis: () => ({
    diagnosis: null,
    state: { phase: "connected", attempt: 0 },
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => ({}) },
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationAtom: () => ({}) },
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original()),
  useAtomValue: () => null,
}));
vi.mock("../workspaces/useMeshLayout", () => ({
  useMeshLayout: () => ({ config: mocks.config }),
}));

import { LocalEnvironmentList } from "./LocalEnvironmentList";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";

const mesh: SidebarWorkspacesConfig = {
  ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  machines: {
    "env-studio": { title: "studio", tag: "ST" },
    "env-cloudbox": { title: "cloudbox", tag: "CB" },
    "env-laptop": { title: "laptop", tag: "LT" },
  },
};

function summaries(): ConnectedEnvironmentSummary[] {
  return ["env-studio", "env-cloudbox", "env-laptop"].map((environmentId) => ({
    environmentId: environmentId as ConnectedEnvironmentSummary["environmentId"],
    environmentLabel: "shared-host",
    displayUrl: "http://10.0.0.1/",
    isRelayManaged: false,
    isEnabled: true,
    connectionState: "connected",
    connectionError: null,
    connectionErrorTraceId: null,
  }));
}

function renderList() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <LocalEnvironmentList
        environments={summaries()}
        expandedId={null}
        onToggle={() => {}}
        onReconnect={() => {}}
        onRemove={() => {}}
        onSetEnabled={() => {}}
        onUpdate={async () => ({ _tag: "Success", value: undefined }) as never}
      />,
    ),
  );
  return { container, dispose: () => act(() => root.unmount()) };
}

it("lists a mesh's connections by config tag and title, one row per machine", () => {
  mocks.config = mesh;
  const screen = renderList();
  try {
    const text = screen.container.textContent!;
    for (const value of ["ST", "studio", "CB", "cloudbox", "LT", "laptop"]) {
      expect(text).toContain(value);
    }
    expect(text).not.toContain("shared-host");
    for (const title of ["studio", "cloudbox", "laptop"]) {
      expect(text.match(new RegExp(title, "g"))).toHaveLength(1);
    }
  } finally {
    screen.dispose();
  }
});

it("keeps the saved host name without a mesh", () => {
  mocks.config = null;
  const screen = renderList();
  try {
    expect(screen.container.textContent!.match(/shared-host/g)).toHaveLength(3);
  } finally {
    screen.dispose();
  }
});
