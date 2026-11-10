import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  useColorScheme: () => "light",
  View: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../state/workspace", () => ({ useWorkspaceEnvironments: () => [] }));
vi.mock("./useMeshLayout", () => ({
  useMeshLayout: () => ({
    config: { machines: { remote: { label: "Build machine", tag: "BLD" } } },
  }),
  useMeshLayoutOptional: () => ({
    config: { machines: { remote: { label: "Build machine", tag: "BLD" } } },
  }),
}));

import { FileMachineTag } from "./FileMachineTag";

it("identifies the machine of a remote file and omits attribution for same-machine or standalone files", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(<FileMachineTag fileEnvironmentId="remote" threadEnvironmentId="local" />),
    );
    expect(container.querySelector('[aria-label="Machine: Build machine"]')?.textContent).toBe(
      "BLD",
    );
    act(() =>
      root.render(<FileMachineTag fileEnvironmentId="remote" threadEnvironmentId="remote" />),
    );
    expect(container.textContent).toBe("");
    act(() => root.render(<FileMachineTag fileEnvironmentId="remote" />));
    expect(container.textContent).toBe("");
  } finally {
    act(() => root.unmount());
  }
});
