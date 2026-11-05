import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  confirm: vi.fn(),
  models: [] as Array<{
    label: string;
    isUnavailable: boolean;
    selection: { instanceId: string; model: string };
  }>,
}));
vi.mock("react-native", () => {
  const Box = ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  );
  return {
    View: Box,
    ScrollView: Box,
    Modal: ({ children, visible }: { children?: ReactNode; visible?: boolean }) =>
      visible === false ? null : <div>{children}</div>,
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      accessibilityState,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      accessibilityLabel?: string;
      accessibilityState?: { expanded?: boolean };
      disabled?: boolean;
    }) => (
      <button
        aria-label={accessibilityLabel}
        aria-expanded={accessibilityState?.expanded}
        disabled={disabled}
        onClick={onPress}
      >
        {children}
      </button>
    ),
    TextInput: ({
      accessibilityLabel,
      value,
      onChangeText,
    }: {
      accessibilityLabel?: string;
      value?: string;
      onChangeText?: (value: string) => void;
    }) => (
      <input
        aria-label={accessibilityLabel}
        value={value ?? ""}
        onChange={(event) => onChangeText?.(event.currentTarget.value)}
      />
    ),
  };
});
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/Sheet", () => ({
  Sheet: ({ children, title }: { children?: ReactNode; title: string }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({
  confirm: (options: unknown) => mocks.confirm(options),
  alert: vi.fn(),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: { navigate: (...args: unknown[]) => mocks.navigate(...args) },
}));
vi.mock("./AdoptReplicaAction", () => ({ AdoptReplicaAction: () => <button>Adopt</button> }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    id: "thread",
    environmentId: "studio",
    projectId: "notes",
    title: "Field notes",
    modelSelection: { instanceId: "codex", model: "sol" },
    runtimeMode: "full-access",
  }),
}));
vi.mock("./moveThreadState", () => ({ movingThread: "moving" }));
vi.mock("./forkThreadState", () => ({ forkingThread: "forking" }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { set: vi.fn() } }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { fork: "fork", forkCatalog: "catalog" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: { providers: [] } }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    {
      id: "archive",
      environmentId: "studio",
      title: "Archive",
      rootPath: "/archive",
      isScratch: false,
    },
  ],
  useServerConfigs: () => new Map([["studio", {}]]),
  useEnvironmentServerConfig: () => ({ providers: [] }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "studio", connection: { phase: "connected" } }],
  }),
}));
vi.mock("../../lib/modelOptions", () => ({
  buildModelOptions: () => mocks.models,
  groupByProvider: () => [],
}));
vi.mock("../threads/ThreadSettingsSheet", () => ({
  ThreadSettingsInlinePicker: () => <span>Choose a model</span>,
}));
vi.mock("./useSidebarWorkspaces", () => ({
  useSidebarWorkspaces: () => ({
    config: {
      ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
      machines: { studio: { title: "Studio" }, cloudbox: { title: "Cloudbox" } },
      projectMounts: {
        notes: [
          {
            environmentId: "studio",
            projectId: "notes",
            role: "primary",
            transport: "git",
            path: "/notes",
            createdAt: "",
          },
        ],
      },
      projectMountStatus: { notes: { studio: { state: "watching", updatedAt: "" } } },
    },
  }),
}));

import { DraftMachineStatus, ReplicaWorkspaceControls } from "./DraftMachineStatus";
import { MachinePickerGroups } from "./MachinePickerGroups";
import { MachinesSheet } from "./MachinesSheet";
import { MoveThreadSheet } from "./MoveThreadSheet";
import { ForkThreadSheet } from "./ForkThreadSheet";

function setup() {
  mocks.navigate.mockReset();
  mocks.confirm.mockReset();
  mocks.models = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  return {
    container,
    render: (node: ReactNode) => act(() => root.render(node)),
    click: (label: string) =>
      act(() => {
        const button = [...container.querySelectorAll("button")].find(
          (button) =>
            button.textContent?.includes(label) || button.getAttribute("aria-label") === label,
        );
        if (!button) throw new Error(`Missing button ${label}`);
        button.click();
      }),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

it("uses one composer status by priority and offers the authenticated machine with a reason", () => {
  using screen = setup();
  const onSwitch = vi.fn();
  const onRetry = vi.fn();
  screen.render(
    <DraftMachineStatus
      preparing="Preparing Cloudbox · 42%"
      reason="Model is unavailable here"
      alternative="Studio"
      onSwitch={onSwitch}
    />,
  );
  expect(screen.container.textContent).toBe("Preparing Cloudbox · 42%");
  expect(screen.container.querySelector("button")).toBeNull();
  screen.render(
    <DraftMachineStatus
      error="Sync failed"
      preparing="Preparing Cloudbox · 42%"
      reason="Model is unavailable here"
      onRetry={onRetry}
    />,
  );
  expect(screen.container.textContent).toBe("Sync failedRetry");
  screen.click("Retry");
  expect(onRetry).toHaveBeenCalledOnce();
  screen.render(
    <DraftMachineStatus
      reason="Codex is not authenticated on Cloudbox"
      alternative="Studio"
      onSwitch={onSwitch}
    />,
  );
  expect(screen.container.textContent).toContain("Codex is not authenticated on Cloudbox");
  screen.click("Switch to Studio where it works");
  expect(onSwitch).toHaveBeenCalledOnce();
});
it("hides local git controls for a replica and retains controls for a primary", () => {
  using screen = setup();
  const config: SidebarWorkspacesConfig = {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    machines: { studio: { title: "Studio" } },
    projectMounts: {
      notes: [
        {
          environmentId: "studio",
          projectId: "primary",
          role: "primary",
          transport: "git",
          path: "/notes",
          createdAt: "",
        },
        {
          environmentId: "cloudbox",
          projectId: "copy",
          source: "studio",
          role: "replica",
          transport: "mutagen",
          path: "/copy",
          createdAt: "",
        },
      ],
    },
  };
  screen.render(
    <ReplicaWorkspaceControls config={config} environmentId="cloudbox" projectId="copy">
      <button>Branch · Current checkout</button>
    </ReplicaWorkspaceControls>,
  );
  expect(screen.container.textContent).toBe("git on Studio · t3 run");
  expect(screen.container.querySelector("button")).toBeNull();
  screen.render(
    <ReplicaWorkspaceControls
      config={config}
      environmentId="cloudbox"
      projectId="primary"
      projectEnvironmentId="studio"
    >
      <button>Branch · Current checkout</button>
    </ReplicaWorkspaceControls>,
  );
  expect(screen.container.textContent).toBe("git on Studio · t3 run");
  expect(screen.container.querySelector("button")).toBeNull();
  screen.render(
    <ReplicaWorkspaceControls config={config} environmentId="studio" projectId="primary">
      <button>Branch · Current checkout</button>
    </ReplicaWorkspaceControls>,
  );
  expect(screen.container.textContent).toBe("Branch · Current checkout");
});
it("keeps old phone connections collapsed until Unavailable is expanded", () => {
  using screen = setup();
  const select = vi.fn();
  const machines = [
    { name: "Studio", online: true },
    { name: "Old laptop", online: false },
  ];
  screen.render(
    <MachinePickerGroups machines={machines} available={(machine) => machine.online}>
      {(machine) => (
        <button key={machine.name} onClick={() => select(machine.name)}>
          {machine.name}
        </button>
      )}
    </MachinePickerGroups>,
  );
  expect(screen.container.textContent).not.toContain("Old laptop");
  screen.click("Unavailable (1)");
  expect(screen.container.textContent).toContain("Old laptop");
  screen.click("Old laptop");
  expect(select).toHaveBeenCalledWith("Old laptop");
  screen.click("Unavailable (1)");
  expect(screen.container.textContent).not.toContain("Old laptop");
});
it("warns before removing a primary, omits Adopt when synced, and opens conflict copies", () => {
  using screen = setup();
  const remove = vi.fn();
  const config: SidebarWorkspacesConfig = {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    machines: { studio: { title: "Studio" } },
    projectMounts: {
      notes: [
        {
          environmentId: "studio",
          projectId: "primary",
          role: "primary",
          transport: "git",
          path: "/notes",
          createdAt: "",
        },
      ],
    },
    projectMountStatus: {
      notes: {
        studio: {
          state: "watching",
          updatedAt: "",
          conflictCopies: { environmentId: "studio", path: "/notes/.t3-conflicts/copy" },
        },
      },
    },
  };
  screen.render(
    <MachinesSheet
      config={config}
      projectKey="notes"
      title="Field notes"
      liveStatuses={[]}
      machines={[]}
      onClose={vi.fn()}
      onAddReplica={vi.fn()}
      onMakePrimary={vi.fn()}
      onRemove={remove}
      onRetry={vi.fn()}
    />,
  );
  expect(screen.container.textContent).not.toContain("Adopt");
  screen.click("Remove");
  expect(remove).not.toHaveBeenCalled();
  const confirmation = mocks.confirm.mock.calls[0]?.[0] as {
    message: string;
    onConfirm: () => void;
  };
  expect(confirmation.message).toContain("leaves replicas without their git and build machine");
  act(confirmation.onConfirm);
  expect(remove).toHaveBeenCalledWith("studio");
  screen.click("Open copies");
  expect(mocks.navigate).toHaveBeenCalledWith(
    "OpenFile",
    expect.objectContaining({ cwd: "/notes/.t3-conflicts/copy" }),
  );
});
it("shows a short no-models reason, expandable details, provider settings and project sync status", () => {
  using screen = setup();
  screen.render(<ForkThreadSheet />);
  screen.click("Studio");
  expect(screen.container.textContent).toContain("No models are available on Studio.");
  expect(screen.container.textContent).toContain("Project synced on Studio");
  expect(screen.container.textContent).not.toContain("Enable and authenticate");
  screen.click("Details");
  expect(screen.container.textContent).toContain("Enable and authenticate a provider");
  screen.click("Open provider settings");
  expect(mocks.navigate).toHaveBeenCalledWith("Settings");
});
it("labels the native fork model picker as Model and opens the picker", () => {
  using screen = setup();
  mocks.models = [
    { label: "Sol", selection: { instanceId: "codex", model: "sol" }, isUnavailable: false },
  ];
  screen.render(<ForkThreadSheet />);
  screen.click("Studio");
  screen.click("Fork model");
  expect(screen.container.textContent).toContain("ModelSol");
  expect(screen.container.textContent).toContain("Choose a model");
  expect(screen.container.textContent).not.toContain("Synced");
});

it("explains that moving a thread changes only its project on the same machine", () => {
  using screen = setup();
  screen.render(<MoveThreadSheet />);
  screen.click("Archive");
  expect(screen.container.textContent).toContain("Stays on Studio; only its project changes.");
  expect(screen.container.querySelector('button[aria-label="Confirm move"]')).not.toBeNull();
});
