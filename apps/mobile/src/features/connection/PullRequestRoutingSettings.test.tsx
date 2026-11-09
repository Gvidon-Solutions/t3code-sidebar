import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
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
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/ListChoiceRow", () => ({ ListChoiceRow: () => null }));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../state/use-atom-command", async (original) => ({
  ...(await original()),
  useAtomCommand: (() => async () => ({ _tag: "Success", value: undefined })) as never,
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: {
    catalogValueAtom: "catalog",
    pullRequestRoutingPermissionsValueAtom: "permissions",
    setPullRequestRoutingPermission: "set",
  },
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown) => (atom === "catalog" ? catalog : [])) as never,
}));
vi.mock("../workspaces/useMeshLayout", () => ({
  useMeshLayout: () => ({ config: mocks.config }),
}));

import { PullRequestRoutingSettings } from "./PullRequestRoutingSettings";

const mesh: SidebarWorkspacesConfig = {
  ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  machines: {
    "env-studio": { title: "studio", tag: "ST" },
    "env-cloudbox": { title: "cloudbox", tag: "CB" },
    "env-laptop": { title: "laptop", tag: "LT" },
  },
};

const catalog = {
  isReady: true,
  entries: new Map(
    ["env-studio", "env-cloudbox", "env-laptop"].map((environmentId) => [
      environmentId,
      {
        target: {
          _tag: "PrimaryConnectionTarget",
          environmentId,
          label: "shared-host",
          httpBaseUrl: "http://10.0.0.1",
          wsBaseUrl: "ws://10.0.0.1",
        },
        profile: Option.none(),
        enabled: true,
      },
    ]),
  ),
};

function renderSettings() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<PullRequestRoutingSettings />));
  return { container, dispose: () => act(() => root.unmount()) };
}

it("names pull-request routing rows by mesh tag and title, one row per machine", () => {
  mocks.config = mesh;
  const screen = renderSettings();
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
  const screen = renderSettings();
  try {
    expect(screen.container.textContent!.match(/shared-host/g)).toHaveLength(3);
  } finally {
    screen.dispose();
  }
});
