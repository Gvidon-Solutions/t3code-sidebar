import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG as empty } from "@t3tools/contracts";
import { projectMachineStrip } from "@t3tools/client-runtime/state/mesh-layout";

vi.mock("react-native", () => ({
  useColorScheme: () => "light",
  View: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
    onLongPress,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
    onLongPress?: () => void;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress} onDoubleClick={onLongPress}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-reanimated", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    default: { View },
    cancelAnimation: () => undefined,
    ReduceMotion: { System: 0 },
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: number) => ({ get: () => value, set: () => undefined }),
    withRepeat: (value: number) => value,
    withTiming: (value: number) => value,
  };
});
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./useMeshLayout", () => ({ useMeshLayoutOptional: () => ({ config: null }) }));

import { ProjectMachineStrip } from "./ProjectMachineStrip";

function renderStrip(model: ReturnType<typeof projectMachineStrip>, onOpen = () => undefined) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<ProjectMachineStrip model={model} onOpen={onOpen} />));
  return { container, root };
}

const machines = {
  studio: { label: "Studio" },
  cloudbox: { label: "Cloudbox" },
  laptop: { label: "Laptop" },
  bench: { label: "Bench" },
};

it("shows every machine tag for three machines and never hides one behind +N", () => {
  const model = projectMachineStrip(
    {
      ...empty,
      machines: { studio: machines.studio, cloudbox: machines.cloudbox, laptop: machines.laptop },
    },
    {
      projectKey: "demo",
      environmentIds: ["studio", "cloudbox", "laptop"],
      knownEnvironmentIds: ["studio", "cloudbox", "laptop"],
    },
    [],
  );
  const { container, root } = renderStrip(model);
  try {
    expect(container.querySelectorAll('[aria-label^="Machine:"]')).toHaveLength(3);
    expect(container.textContent).not.toContain("+");
  } finally {
    act(() => root.unmount());
  }
});

it("lists the hidden machines behind +N only from four machines", () => {
  const opened = vi.fn();
  const model = projectMachineStrip(
    { ...empty, machines },
    {
      projectKey: "demo",
      environmentIds: ["studio", "cloudbox", "laptop", "bench"],
      knownEnvironmentIds: ["studio", "cloudbox", "laptop", "bench"],
    },
    [],
  );
  const { container, root } = renderStrip(model, opened);
  try {
    expect(container.textContent).toContain("+1");
    const overflow = container.querySelector<HTMLElement>('[aria-label="Also on Bench"]');
    expect(overflow).not.toBeNull();
    act(() => overflow?.click());
    expect(opened).toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});
