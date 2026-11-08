import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  CommandId,
  ThreadId,
  MessageId,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  OrchestrationMessageContext,
  type SidebarWorkspacesConfig,
  type ServerConfig,
} from "@t3tools/contracts";
import { draftModelUnavailableReason } from "./draftMachine.ts";
import { plainErrorMessage } from "../../errors/plainMessage.ts";
import { replicaProjectId } from "./replicas.ts";
import type { ReplicaLiveStatus } from "@t3tools/contracts";
import type { StartThreadTurnInput } from "../../operations/commands.ts";

export const PendingDraftAttachment = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["image", "file"]),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});
export type PendingDraftAttachment = typeof PendingDraftAttachment.Type;
export const PendingDraftSend = Schema.Struct({
  draftId: Schema.String,
  environmentId: EnvironmentId,
  logicalKey: Schema.String,
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.String,
  originalPrompt: Schema.optional(Schema.String),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  context: Schema.optional(OrchestrationMessageContext),
  /** The branch/worktree the draft chose before its machine was ready. */
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  worktreePath: Schema.optional(Schema.NullOr(Schema.String)),
  attachments: Schema.Array(PendingDraftAttachment),
  createdAt: Schema.String,
  state: Schema.Literals(["queued", "sending", "sent"]),
  error: Schema.NullOr(Schema.String),
});
export type PendingDraftSend = typeof PendingDraftSend.Type;
export const decodePendingDraftSends = Schema.decodeUnknownSync(Schema.Array(PendingDraftSend));
export interface PendingDraftStorage {
  load(): Promise<readonly PendingDraftSend[]>;
  save(sends: readonly PendingDraftSend[]): Promise<void>;
}
export interface PendingDraftMesh {
  readonly config: SidebarWorkspacesConfig;
  readonly statuses: readonly ReplicaLiveStatus[];
  readonly machines: ReadonlyMap<
    EnvironmentId,
    {
      readonly connected: boolean;
      readonly config: Pick<ServerConfig, "settings" | "providers"> | null;
    }
  >;
}

/** One connected server's draft-delivery facts, as both clients report them. */
export interface PendingDraftMachineInput {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly config: Pick<ServerConfig, "settings" | "providers"> | null;
}

/** The machine map the outbox reconciles against; web and mobile build the same shape. */
export function pendingDraftMachines(
  environments: ReadonlyArray<PendingDraftMachineInput>,
): PendingDraftMesh["machines"] {
  return new Map(
    environments.map((environment) => [
      environment.environmentId,
      { connected: environment.connected, config: environment.config },
    ]),
  );
}

/** Stored IDs are also the server's launch receipt keys, including after response loss. */
export class PendingDraftOutbox {
  private sends: readonly PendingDraftSend[] = [];
  private listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private attempts = new Map<string, string>();
  private hydration: Promise<void> | null = null;
  private storage: PendingDraftStorage;
  constructor(storage: PendingDraftStorage) {
    this.storage = storage;
  }
  get ready(): Promise<void> {
    this.hydration ??= this.storage.load().then((sends) => {
      this.sends = sends.map((send) =>
        send.state === "sending" ? { ...send, state: "queued" as const } : send,
      );
      this.emit();
    });
    return this.hydration;
  }
  readonly getSnapshot = () => this.sends;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private async write(sends: readonly PendingDraftSend[]) {
    await this.storage.save(sends);
    this.sends = sends;
    this.emit();
  }
  private serialize<A>(run: () => Promise<A>): Promise<A> {
    const next = this.tail.then(() => this.ready).then(run);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  enqueue(send: PendingDraftSend): Promise<void> {
    return this.serialize(async () => {
      if (this.sends.some((item) => item.draftId === send.draftId)) return;
      await this.write([...this.sends, send]);
    });
  }
  retry(draftId: string): Promise<void> {
    this.attempts.delete(draftId);
    return this.serialize(() =>
      this.write(
        this.sends.map((send) => (send.draftId === draftId ? { ...send, error: null } : send)),
      ),
    );
  }
  drain(
    mesh: PendingDraftMesh,
    launch: (send: PendingDraftSend, projectId: string, path: string) => Promise<void>,
    openScratch?: (environmentId: EnvironmentId) => Promise<{ id: string; workspaceRoot: string }>,
  ): Promise<void> {
    return this.serialize(async () => {
      for (const stored of this.sends) {
        if (stored.state === "sent") continue;
        const machine = mesh.machines.get(stored.environmentId);
        if (!machine?.connected || !machine.config) continue;
        let scratch: { id: string; workspaceRoot: string } | null = null;
        if (stored.logicalKey === "scratch" && openScratch) {
          const scratchAttempt = JSON.stringify(["scratch", machine.config, stored.modelSelection]);
          if (this.attempts.get(stored.draftId) === scratchAttempt) continue;
          this.attempts.set(stored.draftId, scratchAttempt);
          try {
            scratch = await openScratch(stored.environmentId);
          } catch (error) {
            const reason = plainErrorMessage(error);
            await this.write(
              this.sends.map((send) =>
                send.draftId === stored.draftId ? { ...send, error: reason } : send,
              ),
            );
            continue;
          }
        }
        const projectId =
          scratch?.id ??
          replicaProjectId(mesh.config, mesh.statuses, stored.logicalKey, stored.environmentId);
        const rep = mesh.config.projectMounts[stored.logicalKey]?.find(
          (rep) => rep.environmentId === stored.environmentId,
        );
        const path = scratch?.workspaceRoot ?? rep?.path;
        if (!projectId || !path) continue;
        const attempt = JSON.stringify([
          scratch ? "scratch" : projectId,
          machine.config,
          stored.modelSelection,
        ]);
        if (!scratch && this.attempts.get(stored.draftId) === attempt) continue;
        this.attempts.set(stored.draftId, attempt);
        let failure: string | null = draftModelUnavailableReason(
          machine.config,
          stored.modelSelection,
          projectId as import("@t3tools/contracts").ProjectId,
        );
        if (failure === null) {
          const sending = { ...stored, state: "sending" as const, error: null };
          await this.write(
            this.sends.map((send) => (send.draftId === stored.draftId ? sending : send)),
          );
          try {
            await launch(sending, projectId, path);
            await this.write(
              this.sends.map((send) =>
                send.draftId === stored.draftId
                  ? { ...send, state: "sent", error: null, attachments: [] }
                  : send,
              ),
            );
            continue;
          } catch (error) {
            failure = plainErrorMessage(error);
          }
        }
        await this.write(
          this.sends.map((send) =>
            send.draftId === stored.draftId ? { ...send, state: "queued", error: failure } : send,
          ),
        );
      }
    });
  }
}

function pendingDraftStartInput(
  send: PendingDraftSend,
  projectId: string,
  attachments: readonly import("@t3tools/contracts").ChatAttachment[],
): import("../../operations/commands.ts").StartThreadTurnInput {
  const title = send.text.trim().slice(0, 72) || "New thread";
  return {
    commandId: send.commandId,
    threadId: send.threadId,
    createdAt: send.createdAt,
    message: {
      messageId: send.messageId,
      role: "user",
      text: send.text,
      attachments,
      ...(send.context
        ? {
            context: {
              ...send.context,
              records: send.context.records.map((record) =>
                "attachmentId" in record
                  ? {
                      ...record,
                      attachmentId:
                        attachments[
                          send.attachments.findIndex(
                            (attachment) => attachment.id === record.attachmentId,
                          )
                        ]?.id ?? record.attachmentId,
                    }
                  : record,
              ),
            },
          }
        : {}),
    },
    modelSelection: send.modelSelection,
    runtimeMode: send.runtimeMode,
    interactionMode: send.interactionMode,
    bootstrap: {
      createThread: {
        projectId: projectId as import("@t3tools/contracts").ProjectId,
        title,
        modelSelection: send.modelSelection,
        runtimeMode: send.runtimeMode,
        interactionMode: send.interactionMode,
        branch: send.branch ?? null,
        worktreePath: send.worktreePath ?? null,
        createdAt: send.createdAt,
      },
    },
  };
}

async function uploadPendingDraftAttachments(
  send: PendingDraftSend,
  upload: (attachment: PendingDraftAttachment) => Promise<string>,
): Promise<import("@t3tools/contracts").ChatAttachment[]> {
  return Promise.all(
    send.attachments.map(async (attachment) => ({
      id: await upload(attachment),
      type: attachment.type,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    })),
  );
}

/**
 * Uploads a stored draft's attachments with the platform's byte transport, then hands the
 * complete launch command to the app's command runner. Each app supplies only those two
 * adapters; the receipt IDs and start input stay shared.
 */
export async function launchPendingDraft(input: {
  readonly send: PendingDraftSend;
  readonly projectId: string;
  readonly upload: (attachment: PendingDraftAttachment) => Promise<string>;
  readonly startTurn: (command: StartThreadTurnInput) => Promise<void>;
}): Promise<void> {
  const attachments = await uploadPendingDraftAttachments(input.send, input.upload);
  await input.startTurn(pendingDraftStartInput(input.send, input.projectId, attachments));
}
