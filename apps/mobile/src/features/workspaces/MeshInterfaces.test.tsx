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
  alert: vi.fn(),
  overview: false,
  connections: [] as unknown[],
  document: {} as Record<string, { h: string; v: unknown }>,
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
  alert: (...args: unknown[]) => mocks.alert(...args),
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
  useAtomValue: () =>
    mocks.overview
      ? []
      : {
          id: "thread",
          environmentId: "studio",
          projectId: "notes",
          title: "Field notes",
          modelSelection: { instanceId: "codex", model: "sol" },
          runtimeMode: "full-access",
        },
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
  useServerConfigs: () =>
    new Map([
      ["studio", {}],
      [
        "cloudbox",
        {
          providers: [],
          settings: {},
          environment: { capabilities: { replicas: true }, label: "Cloudbox" },
        },
      ],
    ]),
  useEnvironmentServerConfig: () => ({ providers: [] }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: mocks.connections,
  }),
}));
vi.mock("../../state/mesh-layout", () => ({ meshLayoutAtoms: {} }));
vi.mock("../../state/peerLinks", () => ({ peerLinkEnvironment: {} }));
vi.mock("./useMeshLayout", () => ({
  useMeshLayout: () => ({ state: { snapshot: { document: mocks.document } } }),
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
      machines: {
        studio: { title: "Studio" },
        cloudbox: { title: "Cloudbox" },
        laptop: { title: "Laptop" },
      },
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
import { useMeshOverview } from "./useMeshOverview";
import { partitionMeshMachines } from "@t3tools/client-runtime/state/mesh-machines";

function setup() {
  mocks.navigate.mockReset();
  mocks.confirm.mockReset();
  mocks.alert.mockReset();
  mocks.overview = false;
  mocks.connections = [
    { environmentId: "studio", connection: { phase: "connected" } },
    { environmentId: "cloudbox", connection: { phase: "connected" } },
    { environmentId: "laptop", connection: { phase: "connected" } },
  ];
  mocks.document = {};
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

it("merges raw phone connections by reported environment identity before counting machines", () => {
  using screen = setup();
  mocks.overview = true;
  const connection = (
    id: string,
    reportedId: string,
    label: string,
    phase: string,
    version: string,
  ) => ({
    environmentId: id,
    label,
    displayUrl: `https://${id}.example`,
    connection: { phase },
    serverConfig: {
      environment: {
        environmentId: reportedId,
        serverVersion: version,
        platform: { os: "linux", arch: "x64" },
        capabilities: { meshLayout: true },
      },
      settings: { linkedEnvironmentsEnabled: true },
    },
  });
  mocks.connections = [
    connection("studio-lan", "studio", "Studio", "connected", "1.5"),
    connection("studio-old", "studio", "Studio", "disconnected", "0.9"),
    connection("cloudbox-lan", "cloudbox", "07e7a1a797ee", "connected", "1.5"),
  ];
  mocks.document = { "machine/stale": { v: {}, h: "1759276800000.00000.studio" } };
  const config = {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    machines: { stale: { title: "Old laptop" } },
  };
  function Overview() {
    const mesh = useMeshOverview({ config });
    const groups = partitionMeshMachines(mesh.machines, config, Date.parse("2026-11-05T00:00:00Z"));
    return (
      <pre>
        {JSON.stringify({
          machines: mesh.machines,
          active: groups.active.length,
          forgotten: groups.forgotten.map((machine) => machine.label),
        })}
      </pre>
    );
  }
  screen.render(<Overview />);
  const result = JSON.parse(screen.container.textContent ?? "null") as {
    machines: Array<{ environmentId: string; label: string; version: string; urls: string[] }>;
    active: number;
    forgotten: string[];
  };
  expect(result.machines).toHaveLength(3);
  expect(result.machines.find((machine) => machine.environmentId === "studio")).toMatchObject({
    label: "Studio",
    version: "1.5",
    urls: ["https://studio-lan.example", "https://studio-old.example"],
  });
  expect(result.machines.find((machine) => machine.environmentId === "cloudbox")?.label).toBe(
    "Unnamed machine",
  );
  expect(result.active).toBe(2);
  expect(result.forgotten).toEqual(["Old laptop"]);
});

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
    <ReplicaWorkspaceControls
      config={config}
      environmentId="cloudbox"
      projectId="copy"
      layoutLoading={false}
    >
      <button>Branch · Current checkout</button>
    </ReplicaWorkspaceControls>,
  );
  expect(screen.container.textContent).toBe("");
  expect(screen.container.querySelector("button")).toBeNull();
  screen.render(
    <ReplicaWorkspaceControls
      config={config}
      environmentId="cloudbox"
      projectId="primary"
      projectEnvironmentId="studio"
      layoutLoading={false}
    >
      <button>Branch · Current checkout</button>
    </ReplicaWorkspaceControls>,
  );
  expect(screen.container.textContent).toBe("");
  expect(screen.container.querySelector("button")).toBeNull();
  screen.render(
    <ReplicaWorkspaceControls
      config={config}
      environmentId="studio"
      projectId="primary"
      layoutLoading={false}
    >
      <button>Branch · Current checkout</button>
    </ReplicaWorkspaceControls>,
  );
  expect(screen.container.textContent).toBe("Branch · Current checkout");
  // No mesh at all: the folder is an ordinary project and git shows.
  screen.render(
    <ReplicaWorkspaceControls
      config={null}
      environmentId="studio"
      projectId="primary"
      layoutLoading={false}
    >
      <button>Branch · Current checkout</button>
    </ReplicaWorkspaceControls>,
  );
  expect(screen.container.textContent).toBe("Branch · Current checkout");
  // A mesh source is loading: wait rather than guess it is a primary.
  screen.render(
    <ReplicaWorkspaceControls
      config={null}
      environmentId="studio"
      projectId="primary"
      layoutLoading
    >
      <button>Branch · Current checkout</button>
    </ReplicaWorkspaceControls>,
  );
  expect(screen.container.textContent).toBe("");
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

it("blocks removing a main copy while another copy exists and offers to promote it", () => {
  using screen = setup();
  const config: SidebarWorkspacesConfig = {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    machines: {
      studio: { title: "Studio" },
      cloudbox: { title: "Cloudbox" },
      laptop: { title: "Laptop" },
    },
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
          projectId: "replica",
          role: "replica",
          transport: "mutagen",
          source: "studio",
          path: "/notes",
          createdAt: "",
        },
      ],
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
      onRemove={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  expect(screen.container.textContent).toContain("Main");
  expect(screen.container.textContent).toContain("Copy");
  expect(screen.container.textContent).toContain("Make main copy");
  expect(screen.container.textContent).not.toContain("Primary");
  expect(screen.container.textContent).not.toContain("Replica");
  mocks.alert.mockReset();
  screen.click("Remove");
  const [, message, buttons] = mocks.alert.mock.calls[0] as [
    string,
    string,
    ReadonlyArray<{ text: string; onPress?: () => void }>,
  ];
  expect(message).toContain("Make another copy the main copy first");
  expect(buttons?.map((button) => button.text)).toContain("Make Cloudbox the main copy");
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
          conflictCopies: {
            environmentId: "studio",
            path: "/notes/.t3-conflicts/copy",
            locations: [
              { environmentId: "studio", path: "/notes/.t3-conflicts/copy" },
              { environmentId: "cloudbox", path: "/cloud/.t3-conflicts/copy" },
            ],
          },
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
  expect(confirmation.message).toContain("ordinary folder");
  act(confirmation.onConfirm);
  expect(remove).toHaveBeenCalledWith("studio");
  screen.click("Open copies on Unnamed machine");
  expect(mocks.navigate).toHaveBeenCalledWith(
    "OpenFile",
    expect.objectContaining({ environmentId: "cloudbox", cwd: "/cloud/.t3-conflicts/copy" }),
  );
});
it("shows a short no-models reason, expandable details, provider settings and project sync status", () => {
  using screen = setup();
  screen.render(<ForkThreadSheet />);
  // The thread's own machine is not offered, and a machine without models stays disabled.
  expect(screen.container.textContent).toContain("Cloudbox (No models here)");
  screen.click("Laptop");
  expect(screen.container.textContent).toContain("No models are available on Laptop.");
  expect(screen.container.textContent).toContain("Preparing project on Laptop");
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
  screen.click("Laptop");
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
