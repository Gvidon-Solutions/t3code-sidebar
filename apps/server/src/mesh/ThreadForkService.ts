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
  type ThreadForkInput,
  type ThreadForkResult,
  type ForkBundle,
  type ChatAttachment,
  type MeshForkOrigin,
  type MeshForkRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { threadLinkHref } from "@t3tools/shared/threadLinks";
import { replicaDriver } from "../replicas/replicaModel.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import { callRouted } from "./MeshRouting.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ReplicaRuntime from "../replicas/ReplicaRuntime.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import {
  visibleConversationItems,
  readForkHistoryItems,
} from "../orchestration-v2/ContextHandoffService.ts";
import { claimPendingAttachments } from "../orchestration-v2/AttachmentClaims.ts";
import { forkEntries, lastForkableRun } from "./forkBundle.ts";
import { ForkTransportResult, type ForkTransportInput } from "./forkTransport.ts";
import { readForkAttachment, receiveForkUpload, clearForkUploads } from "./ForkUploads.ts";
import type { PeerCallLimits } from "../peer/PeerMcpClient.ts";

const failure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });
const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const link = (environmentId: EnvironmentId, threadId: ThreadId) =>
  threadLinkHref({ environmentId, threadId });
const CHUNK = 512 * 1024;
const STEP_TIMEOUT = "120 seconds";

export class ThreadForkService extends Context.Service<
  ThreadForkService,
  {
    readonly fork: (
      input: ThreadForkInput,
      limits: PeerCallLimits,
    ) => Effect.Effect<ThreadForkResult, OrchestratorMcpFailure>;
    readonly receive: (
      input: ForkTransportInput,
      limits: PeerCallLimits,
    ) => Effect.Effect<typeof ForkTransportResult.Type, OrchestratorMcpFailure>;
  }
>()("t3/mesh/ThreadForkService") {}

export const layer = Layer.effect(
  ThreadForkService,
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
    const machineTitle = (
      env: string,
      config: import("./MeshLayoutService.ts").MeshLayoutSnapshot,
    ) =>
      config.config.machines[env]?.title ??
      config.config.machines[env]?.label ??
      config.config.machines[env]?.tag ??
      "another machine";
    const get = (id: ThreadId) =>
      orchestrator
        .getThreadRecords(id, ["messages", "turnItems", "runs", "attempts", "runtimeRequests"])
        .pipe(Effect.mapError(failure));
    const dispatch = (command: Parameters<typeof orchestrator.dispatch>[0]) =>
      orchestrator.dispatch(command).pipe(
        Effect.mapError(failure),
        Effect.timeoutOption(STEP_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(invalid("The thread command did not finish in time.")),
            onSome: Effect.succeed,
          }),
        ),
      );
    const remote = (
      environmentId: EnvironmentId,
      args: ForkTransportInput,
      limits: PeerCallLimits,
    ) =>
      callRouted(
        { links, peers, self },
        {
          environmentId,
          tool: "t3_thread_receive_fork",
          arguments: { ...args },
          limits,
          success: ForkTransportResult,
        },
      ).pipe(
        Effect.timeoutOption(STEP_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(invalid("The target machine did not answer in time.")),
            onSome: Effect.succeed,
          }),
        ),
      );
    const threadIdFor = (
      bundle: Pick<ForkBundle, "id" | "sourceEnvironmentId" | "sourceThreadId">,
    ) =>
      crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            `${bundle.sourceEnvironmentId}:${bundle.sourceThreadId}:${bundle.id}`,
          ),
        )
        .pipe(
          Effect.mapError(() => invalid("Cannot identify the fork.")),
          Effect.map((digest) => ThreadId.make(`fork:${Hex.encode(digest)}`)),
        );
    const resolveRepresentation = Effect.fn("ThreadForkService.resolveRepresentation")(
      function* (input: {
        readonly projectId?: ProjectId | undefined;
        readonly logicalKey?: string | undefined;
      }) {
        const snapshot = yield* mesh.read;
        let logicalKey = input.logicalKey;
        let projectId = input.projectId;
        if (projectId !== undefined) {
          const project = yield* projects.getById(projectId).pipe(Effect.mapError(failure));
          if (Option.isNone(project)) return yield* invalid("The destination project is missing.");
          logicalKey =
            logicalKey ??
            Object.keys(snapshot.config.projectMounts).find((key) =>
              snapshot.config.projectMounts[key]?.some(
                (rep) => rep.environmentId === self && rep.projectId === projectId,
              ),
            ) ??
            logicalKey;
        }
        if (logicalKey === undefined) return yield* invalid("The destination project is missing.");
        let rep = snapshot.config.projectMounts[logicalKey]?.find(
          (entry) => entry.environmentId === self,
        );
        let placed = false;
        if (
          !rep ||
          !rep.projectId ||
          (rep.role === "replica" &&
            snapshot.config.projectMountStatus[logicalKey]?.[self]?.state !== "watching")
        ) {
          const replicas = yield* replicaRuntime.get.pipe(Effect.mapError(failure));
          const result = yield* replicas
            .place({ project: logicalKey, machine: self, wait: 90 })
            .pipe(Effect.mapError(failure));
          if (!result.ready || !result.representation?.projectId)
            return yield* invalid("The destination project representation did not become ready.");
          rep = result.representation;
          placed = true;
        }
        const replicas = yield* replicaRuntime.get.pipe(Effect.mapError(failure));
        const driver = rep.role === "replica" ? replicaDriver(snapshot.config, rep) : undefined;
        if (rep.role === "replica" && !driver)
          return yield* invalid("The replica has no sync driver.");
        const flush =
          rep.role !== "replica"
            ? Effect.succeed(true)
            : driver === self
              ? replicas.flush({ logicalKey, environmentId: self }).pipe(Effect.mapError(failure))
              : remote(
                  EnvironmentId.make(driver!),
                  { action: "flush", forkId: "flush", logicalKey, environmentId: self },
                  { runtimeMode: "full-access", interactionMode: "default" },
                ).pipe(Effect.map((result) => "ok" in result && result.ok));
        const flushed = yield* flush.pipe(
          Effect.timeoutOption("60 seconds"),
          Effect.mapError(failure),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(invalid("The sync session did not flush in time.")),
              onSome: Effect.succeed,
            }),
          ),
        );
        if (!flushed) return yield* invalid("The sync driver did not flush the replica.");
        const config = yield* mesh.read;
        return {
          projectId: ProjectId.make(rep.projectId!),
          logicalKey,
          title: config.config.projectTitles[logicalKey] ?? "Untitled project",
          machine: machineTitle(self, config),
          placed,
          flushed,
        };
      },
    );
    const validateModel = Effect.fn("ThreadForkService.validateModel")(function* (
      selection: ForkBundle["modelSelection"] | undefined,
    ) {
      if (selection === undefined) return;
      const available = yield* providers.getProviders;
      const exact = available.find(
        (provider) => provider.instanceId === selection.instanceId && provider.enabled,
      );
      if (!exact || !exact.models.some((model) => model.slug === selection.model))
        return yield* invalid("The selected model is unavailable on the target machine.");
    });
    const receiveFork = Effect.fn("ThreadForkService.receiveFork")(function* (
      bundle: ForkBundle,
      limits: PeerCallLimits,
    ) {
      const threadId = yield* threadIdFor(bundle);
      const existing = yield* orchestrator.getThreadShell(threadId).pipe(Effect.mapError(failure));
      if (existing) {
        const received = yield* get(threadId);
        if (received.thread.meshFork?.id === bundle.id)
          return {
            threadId,
            environmentId: self,
            link: link(self, threadId),
            machine: machineTitle(self, yield* mesh.read),
            title: received.thread.title,
          } satisfies ThreadForkResult;
        if (received.runs.length > 0 || received.turnItems.length > 0)
          return yield* invalid("The fork target is not empty.");
      }
      const rep = yield* resolveRepresentation({ logicalKey: bundle.logicalKey });
      yield* validateModel(bundle.modelSelection);
      if (exceededDispatchModeLimit(limits, bundle))
        return yield* invalid("The target link does not permit this thread's modes.");
      yield* dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${bundle.id}:create`),
        threadId,
        projectId: rep.projectId,
        title: bundle.title,
        modelSelection: bundle.modelSelection,
        runtimeMode: bundle.runtimeMode,
        interactionMode: bundle.interactionMode,
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "server",
      });
      return yield* Effect.gen(function* () {
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
        const now = yield* DateTime.now;
        const origin: MeshForkOrigin = {
          id: bundle.id,
          environmentId: bundle.sourceEnvironmentId,
          threadId: bundle.sourceThreadId,
          title: bundle.sourceTitle,
          machine: bundle.sourceMachine,
          link: bundle.sourceLink,
          createdAt: DateTime.formatIso(now),
        };
        yield* dispatch({
          type: "thread.fork.record",
          commandId: CommandId.make(`${bundle.id}:record`),
          threadId,
          origin,
          marker: `Forked from ${bundle.sourceTitle} on ${bundle.sourceMachine} ← [Original conversation](${bundle.sourceLink})`,
          entries,
        });
        if (bundle.message && bundle.message.trim().length > 0) {
          const started = yield* Effect.exit(
            dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${bundle.id}:message`),
              threadId,
              messageId: MessageId.make(`${bundle.id}:message`),
              text: bundle.message,
              attachments: [],
              modelSelection: bundle.modelSelection,
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "server",
            }),
          );
          if (started._tag === "Failure") return yield* Effect.failCause(started.cause);
        }
        return {
          threadId,
          environmentId: self,
          link: link(self, threadId),
          machine: machineTitle(self, yield* mesh.read),
          title: bundle.title,
        } satisfies ThreadForkResult;
      }).pipe(
        Effect.onError(() =>
          dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`${bundle.id}:rollback`),
            threadId,
          }).pipe(Effect.catch((error) => Effect.logError("Fork rollback failed", { error }))),
        ),
      );
    });
    const receive: (
      input: ForkTransportInput,
      limits: PeerCallLimits,
    ) => Effect.Effect<typeof ForkTransportResult.Type, OrchestratorMcpFailure> = Effect.fn(
      "ThreadForkService.receive",
    )(function* (input: ForkTransportInput, limits: PeerCallLimits) {
      const key = input.action === "receive" ? input.bundle.id : input.forkId;
      return yield* locks.withLock(
        key,
        Effect.gen(function* () {
          if (input.action === "prepare") {
            const rep = yield* resolveRepresentation({
              projectId: input.projectId,
              logicalKey: input.logicalKey,
            });
            yield* validateModel(input.modelSelection);
            return {
              projectId: rep.projectId,
              logicalKey: rep.logicalKey,
              title: rep.title,
              machine: rep.machine,
              placed: rep.placed,
            };
          }
          if (input.action === "flush") {
            const replicas = yield* replicaRuntime.get.pipe(Effect.mapError(failure));
            return { ok: yield* replicas.flush(input).pipe(Effect.mapError(failure)) };
          }
          if (input.action === "upload")
            return yield* receiveForkUpload(input).pipe(Effect.provide(uploadContext));
          if (input.action === "rollback") {
            if (input.threadId) {
              yield* dispatch({
                type: "thread.delete",
                commandId: CommandId.make(`${input.forkId}:rollback`),
                threadId: ThreadId.make(input.threadId),
              });
            }
            yield* clearForkUploads(input.forkId).pipe(Effect.provide(uploadContext));
            return { ok: true };
          }
          return yield* receiveFork(input.bundle, limits).pipe(
            Effect.ensuring(
              clearForkUploads(input.bundle.id).pipe(
                Effect.provide(uploadContext),
                Effect.catch((error) => Effect.logError("Fork staging cleanup failed", { error })),
              ),
            ),
          );
        }),
      );
    });
    const fork = Effect.fn("ThreadForkService.fork")(function* (
      input: ThreadForkInput,
      limits: PeerCallLimits,
    ) {
      const commandId =
        input.commandId ??
        CommandId.make(
          yield* crypto
            .randomUUIDv4()
            .pipe(Effect.mapError(() => invalid("Cannot allocate a fork id."))),
        );
      return yield* locks.withLock(
        input.threadId,
        Effect.gen(function* () {
          const frozen = yield* get(input.threadId);
          const snapshot = yield* mesh.read;
          const replicas = yield* replicaRuntime.get.pipe(Effect.mapError(failure));
          const sourceMachines = yield* replicas
            .machines(input.projectId ?? frozen.thread.projectId)
            .pipe(Effect.mapError(failure));
          const logicalKey = input.logicalKey ?? sourceMachines.logicalKey;
          const targetEnvironmentId = input.targetEnvironmentId;
          const targetMachine =
            targetEnvironmentId === self
              ? machineTitle(self, snapshot)
              : machineTitle(targetEnvironmentId, snapshot);
          const modelSelection = input.modelSelection ?? frozen.thread.modelSelection;
          const requestedTitle =
            input.title ?? `${frozen.thread.title} (fork)`.trim().slice(0, 200);
          const through = lastForkableRun(frozen.runs);
          const historyItems =
            through === undefined
              ? frozen.thread.historyOrigin === "v1_import"
                ? visibleConversationItems(
                    frozen,
                    frozen.turnItems.filter((item) => item.runId === null),
                  )
                : []
              : yield* readForkHistoryItems(projectionStore, frozen, through).pipe(
                  Effect.timeoutOption(STEP_TIMEOUT),
                  Effect.mapError(failure),
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(invalid("Reading the conversation took too long.")),
                      onSome: Effect.succeed,
                    }),
                  ),
                );
          const visibleIds = new Set(
            historyItems.flatMap((item) =>
              item.type === "user_message" || item.type === "assistant_message"
                ? [item.messageId]
                : [],
            ),
          );
          const copiedEntries = forkEntries({
            messages: frozen.messages.filter((message) => visibleIds.has(message.id)),
            turnItems: historyItems,
          });
          if (targetEnvironmentId === self) {
            const prepared = yield* locks.withLock(
              `receive:${commandId}`,
              resolveRepresentation({
                projectId: input.projectId,
                logicalKey,
              }),
            );
            const bundle: ForkBundle = {
              id: String(commandId),
              sourceEnvironmentId: self,
              sourceThreadId: input.threadId,
              sourceTitle: frozen.thread.title,
              sourceMachine: machineTitle(self, snapshot),
              sourceLink: link(self, input.threadId),
              logicalKey: prepared.logicalKey,
              title: requestedTitle,
              modelSelection,
              runtimeMode: frozen.thread.runtimeMode,
              interactionMode: frozen.thread.interactionMode,
              entries: copiedEntries,
              ...(input.message === undefined ? {} : { message: input.message }),
            };
            const copied = copiedEntries;
            const received = yield* receiveFork(
              {
                ...bundle,
                entries: copied,
              },
              limits,
            );
            yield* linkBack(input.threadId, received, frozen.thread.title).pipe(
              Effect.onError(() =>
                dispatch({
                  type: "thread.delete",
                  commandId: CommandId.make(`${bundle.id}:rollback`),
                  threadId: received.threadId,
                }).pipe(
                  Effect.catch((error) => Effect.logError("Fork rollback failed", { error })),
                ),
              ),
            );
            return {
              threadId: received.threadId,
              environmentId: self,
              link: received.link,
              machine: targetMachine,
              title: received.title,
            };
          }
          if (!(yield* links.enabled))
            return yield* invalid("Enable mesh links before forking to another machine.");
          let received: ThreadForkResult | undefined;
          const failCleanup = Effect.suspend(() =>
            remote(
              targetEnvironmentId,
              {
                action: "rollback",
                forkId: String(commandId),
                ...(received === undefined ? {} : { threadId: String(received.threadId) }),
              },
              limits,
            ),
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Fork rollback on the target machine failed", { error }),
            ),
          );
          return yield* Effect.gen(function* () {
            const prepared = yield* remote(
              targetEnvironmentId,
              {
                action: "prepare",
                forkId: String(commandId),
                ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
                ...(logicalKey === undefined ? {} : { logicalKey }),
                modelSelection,
              },
              limits,
            );
            if (!("projectId" in prepared)) return yield* invalid("The target was not prepared.");
            const bundle: ForkBundle = {
              id: String(commandId),
              sourceEnvironmentId: self,
              sourceThreadId: input.threadId,
              sourceTitle: frozen.thread.title,
              sourceMachine: machineTitle(self, snapshot),
              sourceLink: link(self, input.threadId),
              logicalKey: prepared.logicalKey,
              title: requestedTitle,
              modelSelection,
              runtimeMode: frozen.thread.runtimeMode,
              interactionMode: frozen.thread.interactionMode,
              entries: copiedEntries,
              ...(input.message === undefined ? {} : { message: input.message }),
            };
            const copied = yield* copyAttachments(
              bundle.id,
              copiedEntries,
              targetEnvironmentId,
              limits,
            );
            const result = yield* remote(
              targetEnvironmentId,
              { action: "receive", bundle: { ...bundle, entries: copied } },
              limits,
            );
            if (!("threadId" in result) || !("link" in result))
              return yield* invalid("The target did not acknowledge the fork.");
            if (!("title" in result))
              return yield* invalid("The target did not acknowledge the fork.");
            received = {
              threadId: result.threadId,
              environmentId: targetEnvironmentId,
              link: result.link,
              machine: targetMachine,
              title: result.title,
            };
            yield* linkBack(input.threadId, received, frozen.thread.title);
            return received;
          }).pipe(Effect.tapError(() => failCleanup));
        }),
      );
    });
    const linkBack = Effect.fn("ThreadForkService.linkBack")(function* (
      sourceThreadId: ThreadId,
      fork: ThreadForkResult,
      title: string,
    ) {
      const now = yield* DateTime.now;
      const ref: MeshForkRef = {
        id: `${fork.environmentId}:${fork.threadId}`,
        environmentId: fork.environmentId,
        threadId: fork.threadId,
        title: fork.title || title,
        machine: fork.machine,
        link: fork.link,
        createdAt: DateTime.formatIso(now),
      };
      yield* dispatch({
        type: "thread.fork.linked",
        commandId: CommandId.make(`fork-linked:${ref.id}`),
        threadId: sourceThreadId,
        fork: ref,
      });
    });
    const copyAttachments = Effect.fn("ThreadForkService.copyAttachments")(function* (
      forkId: string,
      entries: ForkBundle["entries"],
      targetEnvironmentId: EnvironmentId,
      limits: PeerCallLimits,
    ) {
      const attachments = new Map<string, ChatAttachment>();
      for (const entry of entries)
        for (const attachment of entry.attachments) attachments.set(attachment.id, attachment);
      const copied = new Map<string, ChatAttachment>();
      for (const attachment of attachments.values()) {
        const bytes = yield* readForkAttachment(attachment).pipe(
          Effect.provide(uploadContext),
          Effect.timeoutOption(STEP_TIMEOUT),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(invalid("Reading an attachment took too long.")),
              onSome: Effect.succeed,
            }),
          ),
        );
        for (let offset = 0; offset < Math.max(1, bytes.length); offset += CHUNK) {
          const uploaded = yield* remote(
            targetEnvironmentId,
            {
              action: "upload",
              forkId,
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
      return entries.map((entry) => ({
        ...entry,
        attachments: entry.attachments.map((attachment) => copied.get(attachment.id) ?? attachment),
      }));
    });
    return ThreadForkService.of({ fork, receive });
  }),
);
