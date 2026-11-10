import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
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
  launchPendingDraft,
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

it("builds the draft machine map from each client's connection facts", async () => {
  const { pendingDraftMachines } = await import("./pendingDraftSend.ts");
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const machines = pendingDraftMachines([
    {
      environmentId: EnvironmentId.make("studio"),
      connected: true,
      config: { settings: DEFAULT_SERVER_SETTINGS, providers: [] },
    },
    { environmentId: EnvironmentId.make("laptop"), connected: false, config: null },
  ]);
  expect([...machines.keys()]).toEqual(["studio", "laptop"]);
  expect(machines.get(EnvironmentId.make("studio"))).toMatchObject({ connected: true });
  expect(machines.get(EnvironmentId.make("laptop"))).toEqual({ connected: false, config: null });
});

it("uploads draft attachments before launching the shared start command", async () => {
  const { launchPendingDraft } = await import("./pendingDraftSend.ts");
  const { CommandId, MessageId, ProviderInstanceId, ThreadId, EnvironmentId } =
    await import("@t3tools/contracts");
  const environmentId = EnvironmentId.make("studio");
  const send = {
    draftId: "draft",
    logicalKey: "demo",
    environmentId,
    commandId: CommandId.make("command"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    text: "Launch me",
    attachments: [
      {
        id: "attachment",
        type: "image" as const,
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:image/png;base64,AAAA",
      },
    ],
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    createdAt: "2026-11-03T00:00:00.000Z",
    state: "queued" as const,
    error: null,
  };
  const order: string[] = [];
  const upload = async (attachment: { readonly id: string }) => {
    order.push(`upload:${attachment.id}`);
    return "uploaded-attachment";
  };
  const commands: unknown[] = [];
  await launchPendingDraft({
    send,
    projectId: "project",
    upload,
    startTurn: async (command) => {
      order.push("start");
      commands.push(command);
    },
  });
  expect(order).toEqual(["upload:attachment", "start"]);
  expect(commands).toHaveLength(1);
  const command = commands[0] as {
    readonly commandId: string;
    readonly threadId: string;
    readonly message: { readonly messageId: string; readonly attachments: readonly unknown[] };
    readonly bootstrap: { readonly createThread: { readonly projectId: string } };
  };
  expect(command.commandId).toBe("command");
  expect(command.threadId).toBe("thread");
  expect(command.message.messageId).toBe("message");
  expect(command.message.attachments).toEqual([
    {
      id: "uploaded-attachment",
      type: "image",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 3,
    },
  ]);
  expect(command.bootstrap.createThread.projectId).toBe("project");
});

it("does not start a turn when an attachment upload fails", async () => {
  const { launchPendingDraft } = await import("./pendingDraftSend.ts");
  const { CommandId, MessageId, ProviderInstanceId, ThreadId, EnvironmentId } =
    await import("@t3tools/contracts");
  const started = { value: false };
  await expect(
    launchPendingDraft({
      send: {
        draftId: "draft",
        logicalKey: "demo",
        environmentId: EnvironmentId.make("studio"),
        commandId: CommandId.make("command"),
        threadId: ThreadId.make("thread"),
        messageId: MessageId.make("message"),
        text: "Launch me",
        attachments: [
          {
            id: "attachment",
            type: "file",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
            dataUrl: "data:text/plain;base64,AA==",
          },
        ],
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-11-03T00:00:00.000Z",
        state: "queued",
        error: null,
      },
      projectId: "project",
      upload: async () => {
        throw new Error("upload refused");
      },
      startTurn: async () => {
        started.value = true;
      },
    }),
  ).rejects.toThrow("upload refused");
  expect(started.value).toBe(false);
});

it("keeps the draft's branch and worktree choice in the queued bootstrap", async () => {
  const { send } = setup();
  const captured: unknown[] = [];
  await launchPendingDraft({
    send: { ...send, branch: "feature", worktreePath: "/checkout/feature" },
    projectId: "bo-project",
    upload: async () => "attachment",
    startTurn: async (command) => {
      captured.push(command.bootstrap?.createThread);
    },
  });
  expect(captured).toEqual([
    expect.objectContaining({ branch: "feature", worktreePath: "/checkout/feature" }),
  ]);
});

it("uses plain text for a launch failure instead of a stringified cause", async () => {
  const { storage, send, registered } = setup();
  const outbox = new PendingDraftOutbox(storage);
  await outbox.enqueue(send);
  await outbox.drain(registered, async () => {
    class RpcClientError extends Schema.TaggedError<RpcClientError>()("RpcClientError", {
      message: Schema.String,
    }) {}
    throw new RpcClientError({ message: "Machine did not answer" });
  });
  expect(outbox.getSnapshot()[0]?.error).toBe("Machine did not answer");
});
