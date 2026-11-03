import { expect, it } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  ThreadId,
  MessageId,
  ProviderInstanceId,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  PendingDraftOutbox,
  decodePendingDraftSends,
  type PendingDraftSend,
  type PendingDraftMesh,
} from "./pendingDraftSend.ts";

function setup() {
  const environmentId = EnvironmentId.make("bo");
  const instanceId = ProviderInstanceId.make("codex");
  let disk: readonly PendingDraftSend[] = [];
  const storage = {
    load: async () => decodePendingDraftSends(JSON.parse(JSON.stringify(disk))),
    save: async (sends: readonly PendingDraftSend[]) => {
      disk = decodePendingDraftSends(JSON.parse(JSON.stringify(sends)));
    },
  };
  const send: PendingDraftSend = {
    draftId: "draft",
    logicalKey: "demo",
    environmentId,
    commandId: CommandId.make("command"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    text: "Keep this message",
    attachments: [],
    modelSelection: { instanceId, model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-11-03T00:00:00.000Z",
    state: "queued",
    error: null,
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
  const mesh: PendingDraftMesh = {
    config: {
      ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
      projectMounts: {
        demo: [
          {
            environmentId,
            path: "/demo",
            role: "replica",
            transport: "mutagen",
            source: "at",
            createdAt: "",
          },
        ],
      },
    },
    statuses: [],
    machines: new Map([[environmentId, { connected: true, config: server }]]),
  };
  const registered = {
    ...mesh,
    config: {
      ...mesh.config,
      projectMounts: {
        demo: mesh.config.projectMounts.demo!.map((rep) => ({ ...rep, projectId: "bo-project" })),
      },
    },
  };
  return { storage, send, mesh, registered };
}
it("hydrates a persisted send after restart, waits for registration and acknowledges it exactly once", async () => {
  const { storage, send, mesh, registered } = setup();
  const first = new PendingDraftOutbox(storage);
  await first.enqueue(send);
  const calls: string[] = [];
  const launch = async (item: PendingDraftSend, project: string) => {
    calls.push(`${item.environmentId}:${project}:${item.text}`);
  };
  await first.drain(mesh, launch);
  expect(calls).toEqual([]);
  const restarted = new PendingDraftOutbox(storage);
  await restarted.drain(registered, launch);
  await restarted.drain(registered, launch);
  await new PendingDraftOutbox(storage).drain(registered, launch);
  expect(calls).toEqual(["bo:bo-project:Keep this message"]);
  expect(restarted.getSnapshot()[0]?.state).toBe("sent");
});
it("replays the same receipt IDs after a server commit followed by response loss", async () => {
  const { storage, send, registered } = setup();
  const first = new PendingDraftOutbox(storage);
  await first.enqueue(send);
  const receipts = new Set<string>();
  let created = 0;
  const server = async (item: PendingDraftSend) => {
    if (!receipts.has(item.commandId)) {
      receipts.add(item.commandId);
      created++;
      throw new Error("Response lost after commit");
    }
  };
  await first.drain(registered, server);
  expect(first.getSnapshot()[0]?.error).toContain("Response lost");
  await new PendingDraftOutbox(storage).drain(registered, server);
  expect(created).toBe(1);
});

it("restores a no-project send and opens scratch on its selected machine", async () => {
  const { storage, send, mesh } = setup();
  await new PendingDraftOutbox(storage).enqueue({ ...send, logicalKey: "scratch" });
  const opened: string[] = [];
  const launched: string[] = [];
  const restored = new PendingDraftOutbox(storage);
  const openScratch = async (environmentId: EnvironmentId) => {
    opened.push(environmentId);
    return { id: "bo-scratch", workspaceRoot: "/scratch" };
  };
  const launch = async (item: PendingDraftSend, project: string) => {
    launched.push(`${item.environmentId}:${project}:${item.text}`);
  };
  await restored.drain(mesh, launch, openScratch);
  await restored.drain(mesh, launch, openScratch);
  expect(opened).toEqual(["bo"]);
  expect(launched).toEqual(["bo:bo-scratch:Keep this message"]);
});
