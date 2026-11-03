import { exceededDispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { DocumentText } from "../provider/DocumentText.ts";
import {
  CommandId,
  EnvironmentId,
  ThreadId,
  ProjectId,
  MessageId,
  OrchestratorMcpFailure,
  ThreadMoveResult,
  type ThreadMoveInput,
  type HandoffBundle,
  type ThreadHandoffState,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { threadLinkHref } from "@t3tools/shared/threadLinks";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import { callRouted } from "./MeshRouting.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import { OrchestratorV2, threadHasUnfinishedWork } from "../orchestration-v2/Orchestrator.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ReplicaRuntime from "../replicas/ReplicaRuntime.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import {
  readInheritedHandoffItems,
  visibleConversationItems,
} from "../orchestration-v2/ContextHandoffService.ts";
import { claimPendingAttachments } from "../orchestration-v2/AttachmentClaims.ts";
import { handoffEntries } from "./handoffBundle.ts";
import { ReceiveHandoffResult, type ReceiveHandoffInput } from "./handoffTransport.ts";
import { readHandoffAttachment, receiveHandoffUpload } from "./HandoffUploads.ts";
import type { PeerCallLimits } from "../peer/PeerMcpClient.ts";

const failure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });
const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const link = (environmentId: EnvironmentId, threadId: ThreadId) =>
  threadLinkHref({ environmentId, threadId });
const CHUNK = 512 * 1024;
export class ThreadHandoffService extends Context.Service<
  ThreadHandoffService,
  {
    readonly move: (
      input: ThreadMoveInput,
      limits: PeerCallLimits,
    ) => Effect.Effect<ThreadMoveResult, OrchestratorMcpFailure>;
    readonly receive: (
      input: ReceiveHandoffInput,
      limits: PeerCallLimits,
    ) => Effect.Effect<typeof ReceiveHandoffResult.Type, OrchestratorMcpFailure>;
  }
>()("t3/mesh/ThreadHandoffService") {}

export const layer = Layer.effect(
  ThreadHandoffService,
  Effect.gen(function* () {
    const uploadContext = yield* Effect.context<
      | FileSystem.FileSystem
      | Path.Path
      | Crypto.Crypto
      | ServerSecretStore
      | ServerConfig
      | DocumentText
    >();
    const mesh = yield* MeshLayoutService;
    const links = yield* PeerLinks;
    const peers = yield* PeerMcpClient;
    const orchestrator = yield* OrchestratorV2;
    const projects = yield* ProjectService;
    const providers = yield* ProviderRegistry;
    const projectionStore = yield* ProjectionStoreV2;
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const replicaRuntime = yield* ReplicaRuntime.ReplicaRuntime;
    const locks = yield* KeyedLock.make<string>();
    const self = EnvironmentId.make(mesh.environmentId);
    const tagOf = (env: string, config: import("./MeshLayoutService.ts").MeshLayoutSnapshot) =>
      config.config.machines[env]?.tag ??
      config.config.machines[env]?.label ??
      env.slice(0, 2).toUpperCase();
    const get = (id: ThreadId) =>
      orchestrator
        .getThreadRecords(id, ["messages", "turnItems", "runs", "attempts", "runtimeRequests"])
        .pipe(Effect.mapError(failure));
    const dispatch = (command: Parameters<typeof orchestrator.dispatch>[0]) =>
      orchestrator.dispatch(command).pipe(Effect.mapError(failure));
    const remote = (
      environmentId: EnvironmentId,
      args: ReceiveHandoffInput,
      limits: PeerCallLimits,
    ) =>
      callRouted(
        { links, peers, self },
        {
          environmentId,
          tool: "t3_thread_receive_handoff",
          arguments: { ...args },
          limits,
          success: ReceiveHandoffResult,
        },
      );
    const record = (
      id: ThreadId,
      state: ThreadHandoffState,
      marker?: string,
      entries?: HandoffBundle["entries"],
    ) =>
      dispatch({
        type: "thread.handoff.record",
        commandId: CommandId.make(`${state.id}:${state.phase}:${id}`),
        threadId: id,
        state,
        ...(marker === undefined ? {} : { marker }),
        ...(entries === undefined ? {} : { entries }),
      });
    const resultOf = (state: ThreadHandoffState) => ({
      threadId: state.threadId,
      environmentId: state.environmentId,
      handoffId: state.id,
      undoUntil: state.undoUntil,
      link: state.link,
      machine: state.tag,
    });
    const receive = Effect.fn("ThreadHandoffService.receive")(function* (
      input: ReceiveHandoffInput,
      limits: PeerCallLimits,
    ) {
      const key = input.action === "receive" ? input.bundle.id : input.handoffId;
      return yield* locks.withLock(
        key,
        Effect.gen(function* () {
          if (input.action === "prepare") {
            const project = yield* projects
              .getById(ProjectId.make(input.projectId))
              .pipe(Effect.mapError(failure));
            if (Option.isNone(project))
              return yield* invalid("The destination project is missing.");
            const snapshot = yield* mesh.read;
            const logicalKey =
              Object.keys(snapshot.config.projectMounts).find((key) =>
                snapshot.config.projectMounts[key]?.some(
                  (rep) =>
                    rep.environmentId === self &&
                    (rep.projectId === input.projectId || rep.path === project.value.workspaceRoot),
                ),
              ) ??
              input.logicalKey ??
              `${self}:${project.value.workspaceRoot}`;
            const yieldDate = yield* DateTime.now;
            if (
              !snapshot.config.projectMounts[logicalKey]?.some((rep) => rep.environmentId === self)
            )
              yield* mesh
                .edit((config) => ({
                  ...config,
                  projectMounts: {
                    ...config.projectMounts,
                    [logicalKey]: [
                      ...(config.projectMounts[logicalKey] ?? []).filter(
                        (rep) => rep.environmentId !== self,
                      ),
                      {
                        environmentId: self,
                        path: project.value.workspaceRoot,
                        projectId: project.value.id,
                        role: "primary",
                        transport: "git",
                        createdAt: DateTime.formatIso(yieldDate),
                      },
                    ],
                  },
                }))
                .pipe(Effect.mapError(failure));
            return {
              project: {
                logicalKey,
                title: snapshot.config.projectTitles[logicalKey] ?? project.value.title,
              },
            };
          }
          if (input.action === "upload")
            return yield* receiveHandoffUpload(input).pipe(Effect.provide(uploadContext));
          if (input.action !== "receive") {
            const threadId = ThreadId.make(input.threadId);
            const projection = yield* get(threadId);
            if (projection.thread.meshHandoff?.id !== input.handoffId)
              return yield* invalid("Handoff does not own this thread.");
            if (input.action === "undo") {
              if (threadHasUnfinishedWork(projection))
                return yield* invalid("Stop the running turn before undoing this move.");
              yield* record(
                threadId,
                { ...projection.thread.meshHandoff, phase: "retracted" },
                `Move undone → [Restored original](${projection.thread.meshHandoff.link})`,
              );
              return { ok: true };
            }
            yield* dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${key}:followup`),
              threadId,
              messageId: MessageId.make(`${key}:followup`),
              text: input.text,
              attachments: [],
              modelSelection: projection.thread.modelSelection,
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "server",
            });
            return { ok: true };
          }
          const bundle = input.bundle;
          const threadId = ThreadId.make(
            `handoff:${Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(`${bundle.sourceEnvironmentId}:${bundle.id}`)).pipe(Effect.mapError(() => invalid("Cannot identify handoff."))))}`,
          );
          const existing = yield* orchestrator
            .getThreadShell(threadId)
            .pipe(Effect.mapError(failure));
          if (existing) {
            const received = yield* get(threadId);
            if (
              received.thread.meshHandoff?.id === bundle.id &&
              received.thread.meshHandoff.threadId === bundle.sourceThreadId &&
              received.thread.meshHandoff.environmentId === bundle.sourceEnvironmentId
            )
              return {
                threadId,
                environmentId: self,
                handoffId: bundle.id,
                undoUntil: 0,
                link: link(self, threadId),
                machine: tagOf(self, yield* mesh.read),
              };
            if (received.runs.length > 0 || received.turnItems.length > 0)
              return yield* invalid("The handoff target is not empty.");
          }
          const snapshot = yield* mesh.read;
          let rep = snapshot.config.projectMounts[bundle.logicalKey]?.find(
            (rep) => rep.environmentId === self && rep.projectId,
          );
          if (
            !rep ||
            (rep.role === "replica" &&
              snapshot.config.projectMountStatus[bundle.logicalKey]?.[self]?.state !== "watching")
          ) {
            const replicas = yield* replicaRuntime.get.pipe(Effect.mapError(failure));
            const placed = yield* replicas
              .place({ project: bundle.logicalKey, machine: self, wait: 600 })
              .pipe(Effect.mapError(failure));
            if (!placed.ready || !placed.representation?.projectId)
              return yield* invalid("The target project representation did not become ready.");
            rep = placed.representation;
          }
          const available = yield* providers.getProviders;
          const exact = available.find(
            (provider) =>
              provider.instanceId === bundle.modelSelection.instanceId && provider.enabled,
          );
          const providerNote = exact
            ? ""
            : `\n\nProvider instance ${bundle.modelSelection.instanceId} is unavailable on this machine. Choose an enabled provider before sending a message.`;
          if (exceededDispatchModeLimit(limits, bundle))
            return yield* invalid("The target link does not permit this thread's modes.");
          yield* dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${bundle.id}:create`),
            threadId,
            projectId: ProjectId.make(rep.projectId!),
            title: bundle.title,
            modelSelection: bundle.modelSelection,
            runtimeMode: bundle.runtimeMode,
            interactionMode: bundle.interactionMode,
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "server",
          });
          const entries = yield* Effect.forEach(bundle.entries, (entry) =>
            Effect.gen(function* () {
              const claimed = yield* claimPendingAttachments({
                threadId,
                attachments: entry.attachments,
              }).pipe(Effect.provide(uploadContext), Effect.mapError(failure));
              const locations = claimed.attachments.map((attachment) => {
                const path = resolveAttachmentPath({
                  attachmentsDir: serverConfig.attachmentsDir,
                  attachment,
                });
                return path
                  ? `Attached file "${attachment.name}" is available at: ${path}`
                  : `Attachment: ${attachment.name}`;
              });
              return {
                ...entry,
                text: [entry.text, ...locations].join("\n"),
                attachments: claimed.attachments,
              };
            }),
          );
          const state: ThreadHandoffState = {
            id: bundle.id,
            phase: "received",
            environmentId: bundle.sourceEnvironmentId,
            threadId: bundle.sourceThreadId,
            link: bundle.sourceLink,
            tag: bundle.sourceTag,
            undoUntil: 0,
          };
          yield* record(
            threadId,
            state,
            `Moved from ${bundle.sourceTag} ← [Original conversation](${bundle.sourceLink})\n\nMoved from ${bundle.sourceTag} · ${bundle.date} · original: ${bundle.sourceLink}${providerNote}`,
            entries,
          );
          return {
            threadId,
            environmentId: self,
            handoffId: bundle.id,
            undoUntil: 0,
            link: link(self, threadId),
            machine: tagOf(self, yield* mesh.read),
          };
        }),
      );
    });
    const move = Effect.fn("ThreadHandoffService.move")(function* (
      input: ThreadMoveInput,
      limits: PeerCallLimits,
    ) {
      const commandId =
        input.commandId ??
        CommandId.make(
          yield* crypto
            .randomUUIDv4()
            .pipe(Effect.mapError(() => invalid("Cannot allocate a move id."))),
        );
      return yield* locks.withLock(
        input.threadId,
        Effect.gen(function* () {
          const projection = yield* get(input.threadId);
          const previous = projection.thread.meshHandoff;
          const now = yield* Clock.currentTimeMillis;
          if (input.undoHandoffId !== undefined) {
            if (
              !previous ||
              previous.id !== input.undoHandoffId ||
              previous.phase !== "completed" ||
              now > previous.undoUntil
            )
              return yield* invalid("The 10-second move undo window has expired.");
            yield* remote(
              previous.environmentId,
              { action: "undo", handoffId: previous.id, threadId: previous.threadId },
              limits,
            );
            yield* record(
              input.threadId,
              { ...previous, phase: "undone" },
              `Move undone · [Archived handoff](${previous.link})`,
            );
            return {
              threadId: input.threadId,
              environmentId: self,
              handoffId: null,
              undoUntil: 0,
              link: link(self, input.threadId),
              machine: tagOf(self, yield* mesh.read),
            };
          }
          if (threadHasUnfinishedWork(projection))
            return yield* invalid("Finish or stop the running turn before moving this thread.");
          if (!input.targetEnvironmentId || input.targetEnvironmentId === self) {
            if (!input.projectId) return yield* invalid("Choose a target project.");
            yield* dispatch({
              type: "thread.move",
              commandId,
              threadId: input.threadId,
              projectId: input.projectId,
            });
            return {
              threadId: input.threadId,
              environmentId: self,
              handoffId: null,
              undoUntil: 0,
              link: link(self, input.threadId),
              machine: tagOf(self, yield* mesh.read),
            };
          }
          if (!(yield* links.enabled))
            return yield* invalid("Enable mesh links before moving to another machine.");
          if (previous?.phase === "completed") {
            if (previous.environmentId !== input.targetEnvironmentId)
              return yield* invalid("This thread has already moved to another machine.");
            if (input.message)
              yield* remote(
                previous.environmentId,
                {
                  action: "followup",
                  handoffId: previous.id,
                  threadId: previous.threadId,
                  text: input.message,
                },
                limits,
              );
            return resultOf(previous);
          }
          if (projection.thread.archivedAt !== null)
            return yield* invalid("Unarchive the thread before moving it.");
          const snapshot = yield* mesh.read;
          const selected = yield* projects
            .getById(input.projectId ?? projection.thread.projectId)
            .pipe(Effect.mapError(failure));
          let logicalKey = input.logicalKey;
          let projectTitle: string;
          if (input.projectId) {
            const prepared = yield* remote(
              input.targetEnvironmentId,
              {
                action: "prepare",
                handoffId: String(commandId),
                projectId: input.projectId,
                ...(logicalKey === undefined ? {} : { logicalKey }),
              },
              limits,
            );
            if (!("project" in prepared))
              return yield* invalid("The target project could not be prepared.");
            logicalKey = prepared.project.logicalKey;
            projectTitle = prepared.project.title;
          } else {
            if (Option.isNone(selected)) return yield* invalid("The source project is missing.");
            const replicas = yield* replicaRuntime.get.pipe(Effect.mapError(failure));
            if (!logicalKey)
              logicalKey = (yield* replicas
                .machines(selected.value.id)
                .pipe(Effect.mapError(failure))).logicalKey;
            const placed = yield* replicas
              .place({
                project: snapshot.config.projectMounts[logicalKey] ? logicalKey : selected.value.id,
                machine: input.targetEnvironmentId,
                wait: 600,
              })
              .pipe(Effect.mapError(failure));
            if (!placed.ready)
              return yield* invalid("The destination project representation is not ready.");
            logicalKey = placed.logicalKey;
            projectTitle = snapshot.config.projectTitles[logicalKey] ?? selected.value.title;
          }
          if (
            previous?.phase === "preparing" &&
            previous.environmentId !== input.targetEnvironmentId
          )
            return yield* invalid("Retry the in-progress move to its original destination.");
          const requestedId = `handoff-${Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(`${self}:${input.threadId}:${commandId}`)).pipe(Effect.mapError(() => invalid("Cannot identify move."))))}`;
          if (previous?.phase === "undone" && previous.id === requestedId)
            return yield* invalid("This handoff was undone; use a new move id.");
          const id = previous?.phase === "preparing" ? previous.id : requestedId;
          const config = yield* mesh.read;
          const state: ThreadHandoffState = {
            id,
            phase: "preparing",
            environmentId: input.targetEnvironmentId,
            threadId: ThreadId.make("pending"),
            link: "",
            tag: tagOf(input.targetEnvironmentId, config),
            undoUntil: 0,
          };
          yield* record(input.threadId, state);
          const frozen = yield* get(input.threadId);
          const inherited = yield* readInheritedHandoffItems(projectionStore, frozen.thread).pipe(
            Effect.mapError(failure),
          );
          const visible = visibleConversationItems(frozen, frozen.turnItems);
          const allMessageIds = new Set(
            frozen.turnItems.flatMap((item) =>
              item.type === "user_message" || item.type === "assistant_message"
                ? [item.messageId]
                : [],
            ),
          );
          const visibleMessageIds = new Set(
            visible.flatMap((item) =>
              item.type === "user_message" || item.type === "assistant_message"
                ? [item.messageId]
                : [],
            ),
          );
          const entries = [
            ...handoffEntries({ messages: [], turnItems: inherited }),
            ...handoffEntries({
              messages: frozen.messages.filter(
                (message) => !allMessageIds.has(message.id) || visibleMessageIds.has(message.id),
              ),
              turnItems: visible,
            }),
          ];
          const attachments = new Map<string, ChatAttachment>();
          for (const entry of entries)
            for (const attachment of entry.attachments) attachments.set(attachment.id, attachment);
          const copied = new Map<string, ChatAttachment>();
          for (const attachment of attachments.values()) {
            const bytes = yield* readHandoffAttachment(attachment).pipe(
              Effect.provide(uploadContext),
            );
            for (let offset = 0; offset < Math.max(1, bytes.length); offset += CHUNK) {
              const uploaded = yield* remote(
                input.targetEnvironmentId,
                {
                  action: "upload",
                  handoffId: id,
                  attachment,
                  offset,
                  data: Buffer.from(bytes.subarray(offset, offset + CHUNK)).toString("base64"),
                  final: offset + CHUNK >= bytes.length,
                },
                limits,
              );
              if ("attachment" in uploaded && uploaded.attachment)
                copied.set(attachment.id, uploaded.attachment);
            }
          }
          if (copied.size !== attachments.size)
            return yield* invalid("Not every attachment was acknowledged by the target.");
          const bundle: HandoffBundle = {
            id,
            sourceEnvironmentId: self,
            sourceThreadId: input.threadId,
            sourceTag: tagOf(self, config),
            sourceLink: link(self, input.threadId),
            date: DateTime.formatIso(DateTime.makeUnsafe(now)),
            logicalKey,
            projectTitle: config.config.projectTitles[logicalKey] ?? projectTitle,
            title: frozen.thread.title,
            modelSelection: frozen.thread.modelSelection,
            runtimeMode: frozen.thread.runtimeMode,
            interactionMode: frozen.thread.interactionMode,
            entries: entries.map((entry) => ({
              ...entry,
              attachments: entry.attachments.map(
                (attachment) => copied.get(attachment.id) ?? attachment,
              ),
            })),
          };
          const received = yield* remote(
            input.targetEnvironmentId,
            { action: "receive", bundle },
            limits,
          );
          if (!("threadId" in received))
            return yield* invalid("The target did not acknowledge the handoff.");
          const completed: ThreadHandoffState = {
            ...state,
            phase: "completed",
            threadId: received.threadId,
            link: link(input.targetEnvironmentId, received.threadId),
            undoUntil: (yield* Clock.currentTimeMillis) + 10_000,
          };
          yield* record(
            input.threadId,
            completed,
            `Moved to ${completed.tag} → [Continue the conversation](${completed.link})`,
          );
          if (input.message)
            yield* remote(
              input.targetEnvironmentId,
              {
                action: "followup",
                handoffId: id,
                threadId: received.threadId,
                text: input.message,
              },
              limits,
            );
          return resultOf(completed);
        }),
      );
    });
    return ThreadHandoffService.of({ move, receive });
  }),
);
