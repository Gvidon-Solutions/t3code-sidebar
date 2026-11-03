import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { createContext, useContext, useState } from "react";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProjectId,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type ServerConfig,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import {
  type PendingDraftSend,
  type PendingDraftMesh,
} from "@t3tools/client-runtime/state/mesh-layout";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { useDraftEnvironmentRouting } from "../chat/useDraftEnvironmentRouting";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { render } from "../../../test/render";
import { PendingDraftDelivery } from "./PendingDraftDelivery";
import { createPendingMeshDrafts } from "../../state/pendingMeshDrafts";
import { BranchToolbarEnvironmentSelector } from "../BranchToolbarEnvironmentSelector";

type FixtureMesh = {
  config: SidebarWorkspacesConfig;
  edit: (update: (config: SidebarWorkspacesConfig) => SidebarWorkspacesConfig) => void;
};
const MeshContext = createContext<FixtureMesh | null>(null);
const fixture = vi.hoisted(() => ({
  useMesh: null as (() => FixtureMesh) | null,
  projects: [] as EnvironmentProject[],
}));
vi.mock("../../hooks/useMeshLayout", () => ({ useMeshLayout: () => fixture.useMesh!() }));
vi.mock("../../state/entities", () => ({ useProjects: () => fixture.projects }));
vi.mock("../../state/meshReplicas", () => ({
  useReplicaStatuses: () => [],
  replicaStatusEnvironment: { retry: {} },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ openScratchProject: async () => null }),
}));
vi.mock("../../hooks/useLoadBalancedEnvironment", () => ({
  useLoadBalancedEnvironment: () => ({
    pending: false,
    failed: false,
    environmentId: null,
    refresh: () => {},
  }),
}));

it("persists send while mounting, leaves the composer, restarts, then launches exactly once on the registered machine", async () => {
  const gv = EnvironmentId.make("gv"),
    op = EnvironmentId.make("op");
  const instanceId = ProviderInstanceId.make("codex");
  fixture.useMesh = function useFixtureMesh() {
    const mesh = useContext(MeshContext);
    if (!mesh) throw new Error("Missing fake mesh");
    return mesh;
  };
  fixture.projects = [
    {
      environmentId: gv,
      id: ProjectId.make("gv-project"),
      title: "demo",
      workspaceRoot: "/demo",
      repositoryIdentity: null,
    } as EnvironmentProject,
  ];
  const draftId = DraftId.make("durable-draft");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(gv, ProjectId.make("gv-project")), draftId, {
      threadId: ThreadId.make("durable-thread"),
      environmentSelection: "manual",
    });
  const dbName = "mesh-draft-browser-recovery";
  const outbox = createPendingMeshDrafts(dbName);
  const config: SidebarWorkspacesConfig = {
    ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    machines: {
      gv: { label: "gvidon", tag: "GV", color: "#667788" },
      op: { label: "Operalia", tag: "OP", color: "#778899" },
    },
    projectMounts: {
      demo: [
        {
          environmentId: gv,
          path: "/demo",
          projectId: "gv-project",
          role: "primary",
          transport: "git",
          createdAt: "",
        },
      ],
    },
  };
  const server = {
    settings: DEFAULT_SERVER_SETTINGS,
    providers: [
      {
        instanceId,
        installed: true,
        auth: { status: "authenticated" },
        models: [{ slug: "model" }],
      },
    ],
  } as unknown as ServerConfig;
  const machines: PendingDraftMesh["machines"] = new Map([
    [op, { connected: true, config: server }],
  ]);
  const threads = new Map<string, { environmentId: string; projectId: string; text: string }>();
  const launches = vi.fn(async (send: PendingDraftSend, projectId: string) => {
    threads.set(send.threadId, { environmentId: send.environmentId, projectId, text: send.text });
  });
  const errors = vi.fn();
  function Draft() {
    const [layout, setLayout] = useState(config);
    return (
      <MeshContext value={{ config: layout, edit: (update) => setLayout(update) }}>
        <Composer />
      </MeshContext>
    );
  }
  function Composer() {
    const { config: layout } = useContext(MeshContext)!;
    const [message, setMessage] = useState("");
    const draftThread = useComposerDraftStore((store) => store.getDraftSession(draftId));
    const availableEnvironments = [
      {
        environmentId: gv,
        projectId: ProjectId.make("gv-project"),
        label: "gvidon",
        isPrimary: true,
        machine: "server" as const,
        connected: true,
      },
      {
        environmentId: op,
        projectId: null,
        label: "Operalia",
        isPrimary: false,
        machine: "server" as const,
        connected: true,
      },
    ];
    const routing = useDraftEnvironmentRouting({
      selection: { instanceId, model: "model" },
      draftId,
      draftThread,
      envLocked: false,
      automaticEnvironment: false,
      logicalProjectEnvironments: availableEnvironments,
      environmentById: new Map(),
      providersByEnvironment: new Map(),
      loadBalancingSettings: { loadBalancingWeights: {} },
      referencedThreadContexts: [],
      activeProviderInstanceId: instanceId,
      selectedProvider: ProviderDriverKind.make("codex"),
      composerHasAttachments: false,
      activeProjectKey:
        layout.projectMounts.demo!.length > 1
          ? "canonical-key-after-placement"
          : "legacy-project-key",
      activeProjectIsScratch: false,
      projectGroupingSettings: selectProjectGroupingSettings(DEFAULT_CLIENT_SETTINGS),
      sendInFlightRef: { current: false },
    });
    return (
      <>
        <PendingDraftDelivery
          outbox={outbox}
          mesh={{ config: layout, statuses: [], machines }}
          launch={launches}
          onError={errors}
        />
        <BranchToolbarEnvironmentSelector
          envLocked={false}
          environmentId={routing.pendingDraftMachineId ?? gv}
          availableEnvironments={[
            {
              environmentId: gv,
              projectId: ProjectId.make("gv-project"),
              label: "gvidon",
              isPrimary: true,
              machine: "server",
              connected: true,
            },
            {
              environmentId: op,
              projectId: null,
              label: "Operalia",
              isPrimary: false,
              machine: "server",
              connected: true,
            },
          ]}
          onEnvironmentChange={routing.onEnvironmentChangeStable}
        />
        <textarea
          aria-label="Message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <button
          onClick={() => {
            const pending = routing.readPendingEnvironmentChange();
            if (!pending) throw new Error("Machine placement lost the pending send target");
            void outbox.enqueue({
              draftId: "durable-draft",
              environmentId: pending.environmentId,
              logicalKey: pending.logicalKey!,
              commandId: CommandId.make("durable-command"),
              threadId: ThreadId.make("durable-thread"),
              messageId: MessageId.make("durable-message"),
              text: message,
              modelSelection: { instanceId, model: "model" },
              runtimeMode: "full-access",
              interactionMode: "default",
              attachments: [],
              createdAt: "2026-11-03T00:00:00.000Z",
              state: "queued",
              error: null,
            });
          }}
        >
          Send
        </button>
        {layout.projectMounts.demo?.some((rep) => rep.environmentId === op) && (
          <div role="status">Mounting on Operalia</div>
        )}
      </>
    );
  }
  await using screen = await render(<Draft />);
  await screen.getByRole("combobox", { name: "Machine" }).click();
  await screen.getByRole("option", { name: /Operalia/ }).click();
  await userEvent.fill(screen.getByRole("textbox", { name: "Message" }), "Run this after mounting");
  await screen.getByRole("button", { name: "Send", exact: true }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Mounting on Operalia");
  await vi.waitFor(() => expect(outbox.getSnapshot()[0]?.text).toBe("Run this after mounting"));
  expect(launches).not.toHaveBeenCalled();
  await screen.rerender(<div>Another page</div>);
  const restored = createPendingMeshDrafts(dbName);
  await restored.ready;
  const registered = {
    ...config,
    projectMounts: {
      ...config.projectMounts,
      demo: [
        ...config.projectMounts.demo!,
        {
          environmentId: op,
          path: "/replica/demo",
          projectId: "op-project",
          role: "replica" as const,
          transport: "mutagen" as const,
          source: gv,
          createdAt: "",
        },
      ],
    },
  };
  await screen.rerender(
    <>
      <div>Another page after restart</div>
      <PendingDraftDelivery
        outbox={restored}
        mesh={{ config: registered, statuses: [], machines }}
        launch={launches}
        onError={errors}
      />
    </>,
  );
  await vi.waitFor(() => expect(restored.getSnapshot()[0]?.state).toBe("sent"));
  await restored.drain({ config: registered, statuses: [], machines }, launches);
  expect(launches).toHaveBeenCalledTimes(1);
  expect([...threads.values()]).toEqual([
    { environmentId: "op", projectId: "op-project", text: "Run this after mounting" },
  ]);
  expect(errors).not.toHaveBeenCalled();
});
