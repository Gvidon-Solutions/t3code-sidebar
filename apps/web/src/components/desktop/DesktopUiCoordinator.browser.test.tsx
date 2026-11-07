import { EnvironmentId, type DesktopUiInfo, type DesktopUiSelection } from "@t3tools/contracts";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render, stubGlobal } from "../../../test/render";
import { APP_VERSION } from "../../branding";
import { DesktopUiVersionRow } from "../settings/DesktopUiVersionRow";
import { DesktopUiCoordinator } from "./DesktopUiCoordinator";

const state = vi.hoisted(() => ({
  version: "studio-1",
  phase: "connected",
  revision: 0,
  listeners: new Set<() => void>(),
}));

vi.mock("../../state/environments", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePrimaryEnvironmentId: () => "studio",
    useEnvironmentHttpBaseUrl: (id: string | null) => (id ? `https://${id}.example/` : null),
    useEnvironments: () => {
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => state.revision,
      );
      return {
        environments: ["studio", "cloudbox"].map((environmentId) => ({
          environmentId,
          connection: { phase: state.phase },
          serverConfig: { environment: { serverVersion: state.version } },
        })),
      };
    },
  };
});
vi.mock("../../composerDraftStore", () => ({
  DraftId: { make: (id: string) => id },
  flushComposerDrafts: vi.fn(),
  useComposerDraftStore: (select: (store: { getDraftSession: () => undefined }) => unknown) =>
    select({ getDraftSession: () => undefined }),
}));
vi.mock("../settings/settingsLayout", () => ({
  SettingsRow: ({ title, description }: { title: string; description: string }) => (
    <section>
      <h2>{title}</h2>
      <p>{description}</p>
    </section>
  ),
}));

function update(patch: { version?: string; phase?: string }) {
  Object.assign(state, patch);
  state.revision += 1;
  for (const listener of state.listeners) listener();
}

function setup() {
  state.version = "studio-1";
  state.phase = "connected";
  state.revision = 0;
  state.listeners.clear();
  let loaded: DesktopUiInfo = {
    source: "server",
    origin: "https://studio.example/",
    environmentId: EnvironmentId.make("studio"),
    version: "studio-1",
    shellVersion: "shell-1",
    reason: null,
  };
  const select = vi.fn(async (selection: DesktopUiSelection) => {
    loaded = {
      ...loaded,
      environmentId: selection.environmentId,
      version: selection.serverVersion,
      origin: selection.httpBaseUrl,
    };
    return false;
  });
  return {
    select,
    bridge: { ui: { select, getInfo: async () => loaded } },
  };
}

it("follows connected thread servers and runtime changes, retaining the source in Settings", async () => {
  const fixture = setup();
  using _bridge = stubGlobal("desktopBridge", fixture.bridge);
  function Client() {
    const [generation, setGeneration] = useState(0);
    return (
      <>
        <DesktopUiCoordinator />
        <DesktopUiVersionRow key={generation} />
        <button onClick={() => setGeneration((value) => value + 1)}>Read loaded UI</button>
      </>
    );
  }
  const rootRoute = createRootRoute({ component: Client });
  const environmentRoute = createRoute({ getParentRoute: () => rootRoute, path: "$environmentId" });
  const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "settings" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([environmentRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: ["/studio"] }),
  });
  const client = () => <RouterProvider router={router} />;
  // This fixture supplies real parameterized routes rather than the helper's root-only router.
  await using screen = await render(client(), { router: false });
  await vi.waitFor(() =>
    expect(fixture.select).toHaveBeenLastCalledWith({
      environmentId: "studio",
      httpBaseUrl: "https://studio.example/",
      serverVersion: "studio-1",
    }),
  );
  await expect.element(screen.getByText(`UI ${APP_VERSION} · shell shell-1`)).toBeVisible();
  await expect.element(screen.getByText("https://studio.example/ · server studio-1")).toBeVisible();

  await act(() => update({ version: "studio-2" }));
  await screen.getByRole("button", { name: "Read loaded UI" }).click();
  await vi.waitFor(() =>
    expect(fixture.select).toHaveBeenLastCalledWith({
      environmentId: "studio",
      httpBaseUrl: "https://studio.example/",
      serverVersion: "studio-2",
    }),
  );
  await screen.getByRole("button", { name: "Read loaded UI" }).click();
  await expect.element(screen.getByText("https://studio.example/ · server studio-2")).toBeVisible();

  await act(() => update({ version: "cloudbox-1" }));
  await act(() => router.history.push("/cloudbox"));
  await screen.getByRole("button", { name: "Read loaded UI" }).click();
  await vi.waitFor(() =>
    expect(fixture.select).toHaveBeenLastCalledWith({
      environmentId: "cloudbox",
      httpBaseUrl: "https://cloudbox.example/",
      serverVersion: "cloudbox-1",
    }),
  );
  await screen.getByRole("button", { name: "Read loaded UI" }).click();
  await expect
    .element(screen.getByText("https://cloudbox.example/ · server cloudbox-1"))
    .toBeVisible();

  await act(() => router.history.push("/settings"));
  await screen.getByRole("button", { name: "Read loaded UI" }).click();
  expect(fixture.select).toHaveBeenLastCalledWith({
    environmentId: "cloudbox",
    httpBaseUrl: "https://cloudbox.example/",
    serverVersion: "cloudbox-1",
  });
  const selections = fixture.select.mock.calls.length;
  await act(() => update({ phase: "reconnecting", version: "cloudbox-2" }));
  await screen.getByRole("button", { name: "Read loaded UI" }).click();
  expect(fixture.select).toHaveBeenCalledTimes(selections);
  await act(() => update({ phase: "connected" }));
  await screen.getByRole("button", { name: "Read loaded UI" }).click();
  await vi.waitFor(() =>
    expect(fixture.select).toHaveBeenLastCalledWith({
      environmentId: "cloudbox",
      httpBaseUrl: "https://cloudbox.example/",
      serverVersion: "cloudbox-2",
    }),
  );
  await screen.getByRole("button", { name: "Read loaded UI" }).click();
  await expect
    .element(screen.getByText("https://cloudbox.example/ · server cloudbox-2"))
    .toBeVisible();
});
