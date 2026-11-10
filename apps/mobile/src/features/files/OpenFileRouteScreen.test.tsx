import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  getItem: vi.fn(),
  setItem: vi.fn(),
  list: vi.fn(),
}));
vi.mock("react-native", () => ({
  useColorScheme: () => "light",
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: state.navigate }),
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: state.getItem, setItem: state.setItem },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ["local", "remote"] }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../state/presentation", () => ({ connectedEnvironmentIdsAtom: {} }));
vi.mock("../../state/files", () => ({ filesEnvironment: { list: state.list } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { entries: [{ name: "README.md", absolutePath: "/remote/README.md", kind: "file" }] },
  }),
}));
vi.mock("../../state/workspace", () => ({
  useWorkspaceEnvironments: () => [
    { environmentId: "local", environmentLabel: "Local" },
    { environmentId: "remote", environmentLabel: "Remote" },
  ],
}));
vi.mock("../workspaces/useMeshLayout", () => ({
  useMeshLayout: () => ({ config: { machines: { remote: { label: "Cloudbox", tag: "CB" } } } }),
  useMeshLayoutOptional: () => ({
    config: { machines: { remote: { label: "Cloudbox", tag: "CB" } } },
  }),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppTextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    accessibilityLabel?: string;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onInput={(event) => onChangeText(event.currentTarget.value)}
      readOnly
    />
  ),
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
    <button onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/Chip", () => ({
  Chip: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));

import { OpenFileRouteScreen } from "./OpenFileRouteScreen";

it("switches machine history and opens a completion on its machine while preserving the originating thread machine", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.navigate.mockReset();
  state.list.mockReset();
  state.getItem.mockReset();
  state.setItem.mockReset();
  state.getItem.mockImplementation(async (key: string) =>
    key.endsWith("local") ? JSON.stringify(["/local/old.md"]) : null,
  );
  state.setItem.mockRejectedValueOnce(new Error("Storage unavailable"));
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <OpenFileRouteScreen
          route={{
            params: { environmentId: "local", threadId: "local-thread", cwd: "/local" },
          }}
        />,
      ),
    );
    expect(container.textContent).toContain("/local/old.md");
    const remote = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "CB Cloudbox",
    );
    expect(remote).toBeDefined();
    await act(async () => remote?.click());
    expect(container.textContent).not.toContain("/local/old.md");
    expect(container.textContent).toContain("No files opened here yet.");
    const path = container.querySelector("input");
    expect(path).not.toBeNull();
    act(() => {
      if (path) {
        path.value = "/remote/REA";
        path.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    expect(state.list).toHaveBeenLastCalledWith({
      environmentId: "remote",
      input: { partialPath: "/remote/REA", limit: 40 },
    });
    const completion = container.querySelector('button[aria-label="README.md, file"]');
    expect(completion).not.toBeNull();
    await act(async () => completion?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(state.navigate).toHaveBeenCalledWith("ThreadFile", {
      environmentId: "remote",
      sourceEnvironmentId: "local",
      cwd: "/",
      projectName: "Cloudbox",
      path: ["", "remote", "README.md"],
    });
    expect(container.textContent).toContain("Storage unavailable");
    expect(state.setItem).toHaveBeenCalledWith(
      "t3code:recent-files:remote",
      JSON.stringify(["/remote/README.md"]),
    );
  } finally {
    act(() => root.unmount());
  }
});
