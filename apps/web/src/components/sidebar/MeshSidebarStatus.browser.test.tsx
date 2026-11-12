import { buildMeshMachines, type MeshMachine } from "@t3tools/client-runtime/state/mesh-machines";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { MeshSidebarStatus } from "./MeshSidebarStatus";

const state = vi.hoisted(() => ({
  enabled: true,
  machines: [] as ReadonlyArray<MeshMachine>,
}));

vi.mock(import("../../hooks/useSettings"), () => ({
  usePrimarySettings: (() => state.enabled) as never,
}));
vi.mock(import("../../hooks/useNowMinute"), () => ({
  useNowMinute: () => "2026-11-03T00:00:00Z",
}));
vi.mock(import("../../hooks/useMeshLayout"), () => ({
  useMeshLayout: (() => ({ config: null })) as never,
}));
vi.mock(import("../../hooks/useMeshOverview"), () => ({
  useMeshOverview: (() => ({ machines: state.machines })) as never,
}));

function Harness() {
  return (
    <SidebarProvider defaultOpen>
      <MeshSidebarStatus />
    </SidebarProvider>
  );
}

const namedConfig = {
  ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  machines: { boreal: { label: "Boreal", tag: "BO", color: "#123456", aliases: [] } },
};

const syncedMachines = buildMeshMachines({
  config: DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  connections: [{ environmentId: "studio", label: "Studio", connected: true }],
});

const failingMachines = buildMeshMachines({
  config: namedConfig,
  connections: [{ environmentId: "atlas", label: "Atlas", connected: true }],
  peerStates: [
    {
      environmentId: "boreal",
      lastExchangeAt: "2026-11-02T23:55:00.000Z",
      lastError: "unreachable",
      sentSeq: 0,
      receivedSeq: 0,
    },
  ],
});

it("renders nothing while the mesh is off or nothing is known", async () => {
  state.enabled = true;
  state.machines = [];
  await using screen = await render(<Harness />);
  expect(screen.container.querySelector("[data-mesh-status-problem]")).toBeNull();
  expect(screen.container.querySelector("button")).toBeNull();
});

it("shows a neutral icon with the synced text in its tooltip and name", async () => {
  state.enabled = true;
  state.machines = syncedMachines;
  await using screen = await render(<Harness />);
  const button = screen.getByRole("button", { name: "Mesh · 1 machine · synced" });
  await expect.element(button).toBeVisible();
  expect(screen.container.querySelector("[data-mesh-status-problem]")).toBeNull();
});

it("adds a warning dot when a machine is offline", async () => {
  state.enabled = true;
  state.machines = failingMachines;
  await using screen = await render(<Harness />);
  const button = screen.getByRole("button", { name: "Boreal is offline · 5 min" });
  await expect.element(button).toBeVisible();
  expect(screen.container.querySelector("[data-mesh-status-problem]")).not.toBeNull();
});

it("opens Mesh settings when clicked", async () => {
  state.enabled = true;
  state.machines = syncedMachines;
  await using screen = await render(<Harness />);
  await userEvent.click(screen.getByRole("button", { name: "Mesh · 1 machine · synced" }));
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/settings/mesh"));
});
