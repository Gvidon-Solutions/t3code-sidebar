import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import type { EnvironmentPresentation } from "~/state/environments";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { SavedBackendListRow } from "./SavedEnvironmentRows";

const mocks = vi.hoisted(() => ({
  config: null as SidebarWorkspacesConfig | null,
}));

vi.mock(import("~/hooks/useMeshLayout"), () => ({
  useMeshLayoutOptional: (() => ({ config: mocks.config, source: null })) as never,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => ({ status: "idle" })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => async () => ({ _tag: "Success", value: undefined })) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  usePreparedConnection: (() => ({ _tag: "None" })) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useRelayEnvironmentDiscovery: (() => ({ environments: new Map() })) as never,
  usePrimaryEnvironmentId: (() => null) as never,
}));
vi.mock(import("./ConnectionDiagnosisDetails"), () => ({
  useConnectionDiagnosis: (() => ({
    diagnosis: null,
    state: { phase: "connected", attempt: 0 },
    relayOnly: false,
  })) as never,
  ConnectionDiagnosisSummary: (() => null) as never,
  ConnectionDiagnosisPanel: (() => null) as never,
}));

const mesh: SidebarWorkspacesConfig = {
  ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  machines: {
    "env-studio": { title: "studio", tag: "ST" },
    "env-cloudbox": { title: "cloudbox", tag: "CB" },
    "env-laptop": { title: "laptop", tag: "LT" },
  },
};

function environment(environmentId: string): EnvironmentPresentation {
  return {
    environmentId: environmentId as EnvironmentPresentation["environmentId"],
    label: "gvidon",
    displayUrl: `http://127.0.0.1:${environmentId.length}/`,
    relayManaged: false,
    entry: {
      target: {
        _tag: "BearerConnectionTarget",
        environmentId,
        label: "gvidon",
        connectionId: environmentId,
      },
      profile: Option.none(),
      enabled: true,
    },
    connection: {
      phase: "connected",
      error: null,
      traceId: null,
    },
    serverConfig: null,
  } as unknown as EnvironmentPresentation;
}

const ids = ["env-studio", "env-cloudbox", "env-laptop"];

it("lists a mesh's connections by config tag and title, without inline jargon", async () => {
  mocks.config = mesh;
  await using screen = await render(
    <div>
      {ids.map((id) => (
        <SavedBackendListRow
          key={id}
          environment={environment(id)}
          meshAware
          removingEnvironmentId={null}
          onSetEnabled={() => {}}
          onRemove={() => {}}
          onAddRoute={() => {}}
        />
      ))}
    </div>,
  );
  const text = screen.container.textContent!;
  for (const value of ["ST", "studio", "CB", "cloudbox", "LT", "laptop"]) {
    expect(text).toContain(value);
  }
  expect(text).not.toContain("gvidon");
  expect(text).not.toContain("Routes");
  expect(text).not.toContain("Permissions");
});

it("keeps the saved host names and inline routes without a mesh", async () => {
  mocks.config = null;
  await using screen = await render(
    <div>
      {ids.map((id) => (
        <SavedBackendListRow
          key={id}
          environment={environment(id)}
          meshAware={false}
          removingEnvironmentId={null}
          onSetEnabled={() => {}}
          onRemove={() => {}}
          onAddRoute={() => {}}
        />
      ))}
    </div>,
  );
  const text = screen.container.textContent!;
  expect(text.match(/gvidon/g)).toHaveLength(3);
  expect(text).toContain("Routes");
  expect(text).toContain("Permissions");
});
