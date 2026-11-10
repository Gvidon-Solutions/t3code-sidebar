vi.mock("../../state/meshReplicas", () => ({ useReplicaStatuses: () => [] }));
vi.mock(import("../../state/query"), () => ({
  useEnvironmentQuery: (() => ({ data: null, error: null })) as never,
}));
import {
  DEFAULT_UNIFIED_SETTINGS,
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarMachine,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { buildMeshMachines } from "@t3tools/client-runtime/state/mesh-machines";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";
import { MeshSettingsPanel } from "./MeshSettingsPanel";

const mocks = vi.hoisted(() => ({
  review: false,
  collision: false,
  link: false,
  environments: [] as ReadonlyArray<{
    readonly environmentId: string;
    readonly label: string;
    readonly connection: { readonly phase: string };
    readonly serverConfig: {
      readonly settings: { readonly linkedEnvironmentsEnabled: boolean };
      readonly environment: { readonly capabilities: { readonly peerLinks?: boolean } };
    };
  }>,
  primaryEnvironmentId: null as string | null,
  machineLinks: [] as ReadonlyArray<{
    readonly environmentId: string;
    readonly links: ReadonlyArray<{
      readonly environmentId: string;
      readonly label: string;
      readonly urls: ReadonlyArray<string>;
      readonly access: "full-access";
      readonly status: string;
      readonly lastReachedAt: null;
      readonly lastError: null;
    }>;
  }>,
  edit: vi.fn<(update: (config: SidebarWorkspacesConfig) => SidebarWorkspacesConfig) => void>(),
}));

function linkEnvironment(environmentId: string) {
  return {
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
    serverConfig: {
      settings: { linkedEnvironmentsEnabled: true },
      environment: { capabilities: { peerLinks: true } },
    },
  };
}

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
    config: reviewConfig(),
    source: "local",
    edit: mocks.edit,
  })) as never,
  useMeshLayoutOptional: (() => ({ config: reviewConfig() })) as never,
}));
vi.mock(import("../../hooks/useMeshOverview"), () => ({
  useMeshOverview: () => ({
    machines: buildMeshMachines({
      config: mocks.link ? linkConfig() : reviewConfig(),
      connections: mocks.link
        ? [
            { environmentId: "cloudbox", label: "cloudbox", connected: true },
            { environmentId: "laptop", label: "laptop", connected: true },
            { environmentId: "studio", label: "studio", connected: true },
          ]
        : [
            { environmentId: "local", label: "Local", connected: true, version: "0.1.5" },
            ...(mocks.review
              ? [
                  {
                    environmentId: "local",
                    label: "Duplicate",
                    connected: false,
                    version: "0.1.5",
                  },
                  {
                    environmentId: "unnamed",
                    label: "07e7a1a797ee",
                    connected: true,
                    version: "0.1.5",
                  },
                ]
              : []),
          ],
      links: mocks.link
        ? []
        : [
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
    links: mocks.machineLinks,
  }),
}));
vi.mock(import("../../hooks/useNowMinute"), () => ({
  useNowMinute: () => "2026-11-03T00:00:00.000Z",
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: mocks.environments })) as never,
  usePrimaryEnvironmentId: (() => (mocks.link ? mocks.primaryEnvironmentId : "local")) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: ((environments: ReadonlyArray<{ environmentId: string }>) =>
    new Set(environments.map((environment) => environment.environmentId))) as never,
  usePreparedConnection: () => Option.none(),
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => vi.fn()) as never,
}));

it("shows each machine as a name with one plain status sentence", async () => {
  mocks.review = false;
  mocks.collision = false;
  mocks.link = false;
  mocks.edit.mockReset();
  await using screen = await render(<MeshSettingsPanel />, { router: "/settings/mesh" });
  await expect.element(screen.getByText("Remote", { exact: true }).first()).toBeVisible();
  await expect.element(screen.getByText("Online", { exact: true }).first()).toBeVisible();
  await expect.element(screen.getByText("Unknown", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("0.1.5", { exact: true })).not.toBeInTheDocument();
});

it("offers Connect to all machines only where it can act", async () => {
  mocks.review = false;
  mocks.collision = false;
  mocks.link = false;
  mocks.edit.mockReset();
  await using screen = await render(<MeshSettingsPanel />, { router: "/settings/mesh" });
  await expect
    .element(screen.getByRole("button", { name: "Connect to all machines" }))
    .toBeVisible();

  using _shell = stubGlobal("desktopShell", { origin: "https://studio.example/" });
  await using serverScreen = await render(<MeshSettingsPanel />, { router: "/settings/mesh" });
  await expect
    .element(serverScreen.getByRole("button", { name: "Connect to all machines" }))
    .not.toBeInTheDocument();
});

it("offers an agent setup button instead of a config editor", async () => {
  mocks.review = false;
  mocks.collision = false;
  mocks.link = false;
  mocks.edit.mockReset();
  await using screen = await render(<MeshSettingsPanel />, { router: "/settings/mesh" });
  await expect
    .element(screen.getByRole("button", { name: "Set up the mesh with an agent" }))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Link a machine" })).toBeVisible();
  await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
  await expect.element(screen.getByText("2 machines · 1 online", { exact: true })).toBeVisible();
  expect(mocks.edit).not.toHaveBeenCalled();
});

function linkConfig(): SidebarWorkspacesConfig {
  const machine = (title: string): SidebarMachine => ({
    title,
    reported: {
      version: "1",
      user: null,
      sshd: null,
      platform: { os: "linux", arch: "x64", release: "test" },
      reportedAt: "2026-11-09T00:00:00Z",
    },
  });
  return {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    machines: {
      cloudbox: machine("cloudbox"),
      laptop: machine("laptop"),
      studio: machine("studio"),
    },
  };
}

function reviewConfig(): SidebarWorkspacesConfig {
  if (mocks.collision)
    return {
      ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
      machines: {
        local: {
          title: "Studio",
          reported: {
            version: "1",
            user: null,
            sshd: null,
            platform: { os: "linux", arch: "x64", release: "test" },
            reportedAt: "2026-11-03T00:00:00Z",
          },
        },
        remote: {
          title: "Studio",
          reported: {
            version: "1",
            user: null,
            sshd: null,
            platform: { os: "darwin", arch: "arm64", release: "test" },
            reportedAt: "2026-11-03T00:00:00Z",
          },
        },
      },
    };
  return mocks.review
    ? {
        ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
        machines: {
          stale: {
            title: "Old laptop",
            reported: {
              version: "1.0",
              user: null,
              sshd: null,
              platform: { os: "linux", arch: "x64", release: "test" },
              reportedAt: "2026-10-01T00:00:00Z",
            },
          },
        },
      }
    : DEFAULT_SIDEBAR_WORKSPACES_CONFIG;
}
it("deduplicates phone-shaped connections, names unknown hosts and excludes forgotten layout facts from the count", async () => {
  mocks.review = true;
  mocks.collision = false;
  mocks.link = false;
  mocks.edit.mockReset();
  await using screen = await render(<MeshSettingsPanel />, { router: "/settings/mesh" });
  await expect.element(screen.getByText("3 machines · 2 online", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Open Unnamed machine details" }))
    .toBeVisible();
  await expect.element(screen.getByText("07e7a1a797ee", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Old laptop", { exact: true })).not.toBeInTheDocument();
  await screen.getByText("Forgotten machines (1)").click();
  await expect.element(screen.getByText("Old laptop · forgotten", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Forget", exact: true }).click();
  expect(mocks.edit).toHaveBeenCalledOnce();
});

it("shows a machine's linked peers in Diagnostics", async () => {
  mocks.review = false;
  mocks.collision = false;
  mocks.link = false;
  mocks.machineLinks = [
    {
      environmentId: "local",
      links: [
        {
          environmentId: "remote",
          label: "Remote",
          urls: ["http://remote"],
          access: "full-access",
          status: "reachable",
          lastReachedAt: null,
          lastError: null,
        },
      ],
    },
  ];
  mocks.edit.mockReset();
  await using screen = await render(<MeshSettingsPanel />, { router: "/settings/mesh" });
  await screen.getByRole("button", { name: "Open Local details" }).click();
  await screen.getByText("Diagnostics").click();
  await expect.element(screen.getByText("Linked with", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(/Remote · Full access/)).toBeVisible();
});

it("distinguishes matching machine titles by platform and short host", async () => {
  mocks.review = false;
  mocks.collision = true;
  mocks.link = false;
  mocks.edit.mockReset();
  await using screen = await render(<MeshSettingsPanel />, { router: "/settings/mesh" });
  await expect
    .element(screen.getByText("Studio (darwin · remote)", { exact: true }).first())
    .toBeVisible();
  await expect
    .element(screen.getByText("Studio (linux · ST)", { exact: true }).first())
    .toBeVisible();
});

it("starts Link from on the machine serving this UI, not the first saved connection", async () => {
  mocks.review = false;
  mocks.collision = false;
  mocks.link = true;
  mocks.edit.mockReset();
  // Saved connections settle before this client's primary environment descriptor.
  mocks.environments = [linkEnvironment("cloudbox"), linkEnvironment("laptop")];
  mocks.primaryEnvironmentId = null;
  await using screen = await render(<MeshSettingsPanel />, { router: "/settings/mesh" });
  mocks.environments = [
    linkEnvironment("cloudbox"),
    linkEnvironment("laptop"),
    linkEnvironment("studio"),
  ];
  mocks.primaryEnvironmentId = "studio";
  await screen.rerender(<MeshSettingsPanel />);
  await screen.getByRole("button", { name: "Link a machine" }).click();
  await expect
    .element(page.getByRole("combobox", { name: "Link from" }))
    .toHaveTextContent("studio");
});
