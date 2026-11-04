vi.mock(import("../../state/query"), () => ({
  useEnvironmentQuery: (() => ({ data: null, error: null })) as never,
}));
import {
  DEFAULT_UNIFIED_SETTINGS,
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { buildMeshMachines } from "@t3tools/client-runtime/state/mesh-machines";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { MeshSettingsPanel } from "./MeshSettingsPanel";

const mocks = vi.hoisted(() => ({
  edit: vi.fn<(update: (config: SidebarWorkspacesConfig) => SidebarWorkspacesConfig) => void>(),
}));

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  usePrimarySettings: (() => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    meshEnabled: true,
    linkedEnvironmentsEnabled: true,
  })) as never,
  useUpdatePrimarySettings: (() => vi.fn()) as never,
}));
vi.mock(import("../../hooks/useMeshLayout"), () => ({
  useMeshLayout: (() => ({
    config: DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    source: "local",
    edit: mocks.edit,
  })) as never,
}));
vi.mock(import("../../hooks/useMeshOverview"), () => ({
  useMeshOverview: () => ({
    machines: buildMeshMachines({
      config: DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
      connections: [{ environmentId: "local", label: "Local", connected: true, version: "0.1.5" }],
      links: [
        {
          environmentId: "local",
          links: [
            {
              environmentId: "remote",
              label: "Remote",
              urls: ["http://remote"],
              status: "reachable",
              lastReachedAt: null,
              lastError: null,
            },
          ],
        },
      ],
    }),
    connections: [],
    links: [],
  }),
}));
vi.mock(import("../../hooks/useNowMinute"), () => ({
  useNowMinute: () => "2026-11-03T00:00:00.000Z",
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [] })) as never,
  usePrimaryEnvironmentId: (() => "local") as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set(),
  usePreparedConnection: () => Option.none(),
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => vi.fn()) as never,
}));

it("shows the known server version and omits a version row for a link without one", async () => {
  mocks.edit.mockReset();
  await using screen = await render(<MeshSettingsPanel />, { router: "/settings/mesh" });
  await expect.element(screen.getByText("Remote", { exact: true }).first()).toBeVisible();
  await expect.element(screen.getByText("Unknown", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Version", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("0.1.5", { exact: true })).toBeVisible();
});

it("keeps configuration fields in the config editor and shows machine state", async () => {
  mocks.edit.mockReset();
  await using screen = await render(<MeshSettingsPanel />, { router: "/settings/mesh" });
  await expect.element(screen.getByRole("button", { name: "Edit config" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Link a machine" })).toBeVisible();
  await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
  await expect.element(screen.getByText("2 machines · 1 online", { exact: true })).toBeVisible();
  expect(mocks.edit).not.toHaveBeenCalled();
});
