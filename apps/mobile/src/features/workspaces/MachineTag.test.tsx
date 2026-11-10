import type { CSSProperties, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  useColorScheme: () => "light",
  View: ({
    children,
    accessibilityLabel,
    testID,
    style,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    testID?: string;
    style?: CSSProperties | CSSProperties[];
  }) => (
    <div
      aria-label={accessibilityLabel}
      data-testid={testID}
      style={(Array.isArray(style) ? Object.assign({}, ...style) : style) as CSSProperties}
    >
      {children}
    </div>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children, style }: { children?: ReactNode; style?: CSSProperties }) => (
    <span style={style}>{children}</span>
  ),
}));
vi.mock("./useMeshLayout", () => ({ useMeshLayoutOptional: () => ({ config: null }) }));

import { MachineTag } from "./MachineTag";

const machine = { label: "Studio", tag: "ST", color: "#6d8cff" };

function renderTag(element: ReactNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

it("draws tinted, solid and outline machine tags with the shared look", () => {
  const { container, root } = renderTag(
    <div>
      <MachineTag
        machine={machine}
        appearance={{ style: "tinted", textColor: "machine" }}
        theme="light"
      />
      <MachineTag
        machine={machine}
        appearance={{ style: "tinted", textColor: "neutral" }}
        theme="light"
      />
      <MachineTag
        machine={machine}
        appearance={{ style: "solid", textColor: "machine" }}
        theme="light"
      />
      <MachineTag
        machine={machine}
        appearance={{ style: "outline", textColor: "machine" }}
        theme="light"
      />
    </div>,
  );
  try {
    const tags = [...container.querySelectorAll<HTMLElement>('[aria-label="Machine: Studio"]')];
    expect(tags).toHaveLength(4);
    const [tinted, neutral, solid, outline] = tags;
    expect(tinted?.style.backgroundColor).toMatch(/^rgba\(/);
    expect(tinted?.querySelector("span")?.style.color).not.toBe("");
    expect(neutral?.querySelector("span")?.style.color).toBe("");
    expect(solid?.style.backgroundColor).toBe("rgb(109, 140, 255)");
    expect(["rgb(0, 0, 0)", "rgb(255, 255, 255)"]).toContain(
      solid?.querySelector("span")?.style.color,
    );
    expect(outline?.style.backgroundColor).toBe("");
    expect(outline?.style.borderColor).not.toBe("");
    expect(outline?.style.borderWidth).toBe("1px");
  } finally {
    act(() => root.unmount());
  }
});

it("dims a muted tag and keeps its machine name in the label", () => {
  const { container, root } = renderTag(
    <MachineTag
      machine={machine}
      muted
      appearance={{ style: "tinted", textColor: "machine" }}
      theme="dark"
    />,
  );
  try {
    const tag = container.querySelector<HTMLElement>('[aria-label="Machine: Studio"]');
    expect(tag?.style.opacity).toBe("0.45");
    expect(container.textContent).toBe("ST");
  } finally {
    act(() => root.unmount());
  }
});
