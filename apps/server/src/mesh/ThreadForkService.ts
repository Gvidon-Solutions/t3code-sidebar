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
  OrchestratorMcpFailure,
  type ThreadForkInput,
  type ThreadForkResult,
  type ForkBundle,
  type ChatAttachment,
  type MeshForkOrigin,
  type MeshForkRef,
  type ThreadForkCatalog,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as Scope from "effect/Scope";
import * as Clock from "effect/Clock";
import * as Schedule from "effect/Schedule";
import * as Fiber from "effect/Fiber";
import * as Duration from "effect/Duration";
import { forkParked } from "../serverActivation.ts";
import * as ForkTransactions from "./ForkTransactions.ts";
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
    readonly catalog: (
      targetEnvironmentId: EnvironmentId,
    ) => Effect.Effect<ThreadForkCatalog, OrchestratorMcpFailure>;
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
    const fileSystem = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const replicaRuntime = yield* ReplicaRuntime.ReplicaRuntime;
    const locks = yield* KeyedLock.make<string>();
    const journal = yield* ForkTransactions.ForkTransactions;
    const transactions = {
      read: (key: string) => journal.read(key).pipe(Effect.mapError(failure)),
      write: (key: string, value: ForkTransactions.ForkTransaction) =>
        journal.write(key, value).pipe(Effect.mapError(failure)),
      remove: (key: string) => journal.remove(key).pipe(Effect.mapError(failure)),
      list: journal.list.pipe(Effect.mapError(failure)),
    };
    const serviceScope = yield* Scope.Scope;
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
        Effect.tapError((error) => Effect.logWarning("Fork command failed", error)),
        Effect.mapError((error) =>
          error._tag === "OrchestratorCommandPreviouslyRejectedError"
            ? invalid(error.detail)
            : failure(error),
        ),
        Effect.timeoutOption(STEP_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(failure({ message: "The thread command did not finish in time." })),
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
            onNone: () =>
              Effect.fail(failure({ message: "The target machine did not answer in time." })),
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
            .pipe(
              Effect.mapError(failure),
              Effect.timeoutOption("100 seconds"),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(invalid("The project placement did not finish in time.")),
                  onSome: Effect.succeed,
                }),
              ),
            );
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
      const available = yield* providers.getProviders.pipe(
        Effect.timeoutOption("30 seconds"),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(invalid("The target model catalog did not answer in time.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      const exact = available.find(
        (provider) =>
          provider.instanceId === selection.instanceId &&
          provider.enabled &&
          provider.installed &&
          provider.status === "ready" &&
          provider.availability !== "unavailable",
      );
      if (!exact || !exact.models.some((model) => model.slug === selection.model))
        return yield* invalid("The selected model is unavailable on the target machine.");
    });
    const receiveFork = Effect.fn("ThreadForkService.receiveFork")(function* (
      bundle: ForkBundle,
      projectId: ProjectId,
    ) {
      const threadId = yield* threadIdFor(bundle);
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
      const entries = bundle.entries.map((entry) => ({
        ...entry,
        text: [
          entry.text,
          ...entry.attachments.map((attachment) => {
            const path = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            return path
              ? `Attached file "${attachment.name}" is available at: ${path}`
              : `Attachment: ${attachment.name}`;
          }),
        ].join("\n"),
      }));
      yield* dispatch({
        type: "thread.fork.record",
        commandId: CommandId.make(`${bundle.id}:publish`),
        threadId,
        create: {
          projectId,
          title: bundle.title,
          modelSelection: bundle.modelSelection,
          runtimeMode: bundle.runtimeMode,
          interactionMode: bundle.interactionMode,
        },
        origin,
        marker: `Forked from ${bundle.sourceTitle} on ${bundle.sourceMachine} ← [Original conversation](${bundle.sourceLink})`,
        entries,
        ...(bundle.message === undefined ? {} : { message: bundle.message }),
      });
      return {
        threadId,
        environmentId: self,
        link: link(self, threadId),
        machine: machineTitle(self, yield* mesh.read),
        title: bundle.title,
      } satisfies ThreadForkResult;
    });
    const clearTransaction = Effect.fn("ThreadForkService.clearTransaction")(function* (
      key: string,
      value: Extract<
        ForkTransactions.ForkTransaction,
        { phase: "pending" | "committing" | "uploading" }
      >,
    ) {
      const fs = fileSystem;
      for (const path of value.phase === "uploading" ? [] : value.claimedPaths)
        yield* fs.remove(path, { force: true }).pipe(Effect.mapError(failure));
      yield* clearForkUploads(value.phase === "uploading" ? value.forkId : value.bundle.id).pipe(
        Effect.provide(uploadContext),
      );
      yield* transactions.remove(key);
    });
    const expire = Effect.fn("ThreadForkService.expire")(function* (key: string) {
      return yield* locks.withLock(
        key,
        Effect.gen(function* () {
          const value = yield* transactions.read(key);
          if (
            (value?.phase === "pending" || value?.phase === "uploading") &&
            value.expiresAt <= (yield* Clock.currentTimeMillis)
          )
            yield* clearTransaction(key, value);
        }),
      );
    });
    const retry = <A>(operation: Effect.Effect<A, OrchestratorMcpFailure>) =>
      operation.pipe(
        Effect.retry({
          while: (error) => error.code === "orchestration_error",
          schedule: Schedule.exponential("1 second").pipe(
            Schedule.modifyDelay(({ duration }) =>
              Effect.succeed(Duration.min(duration, Duration.seconds(15))),
            ),
          ),
        }),
      );
    const armExpiry = Effect.fn("ThreadForkService.armExpiry")(function* (
      key: string,
      expiresAt: number,
    ) {
      const delay = Math.max(0, expiresAt - (yield* Clock.currentTimeMillis));
      yield* Effect.sleep(delay).pipe(
        Effect.andThen(retry(expire(key))),
        Effect.forkIn(serviceScope),
      );
    });
    const stageFork = Effect.fn("ThreadForkService.stageFork")(function* (
      bundle: ForkBundle,
      limits: PeerCallLimits,
    ) {
      const key = `target:${bundle.id}`;
      const previous = yield* transactions.read(key);
      const threadId = yield* threadIdFor(bundle);
      const result = {
        threadId,
        environmentId: self,
        link: link(self, threadId),
        machine: machineTitle(self, yield* mesh.read),
        title: bundle.title,
      };
      if (previous && previous.phase !== "outgoing" && previous.phase !== "uploading")
        return {
          token: previous.token,
          result: previous.phase === "committed" ? previous.result : result,
        };
      const rep = yield* resolveRepresentation({ logicalKey: bundle.logicalKey });
      yield* validateModel(bundle.modelSelection);
      if (exceededDispatchModeLimit(limits, bundle))
        return yield* invalid("The target link does not permit this thread's modes.");
      const claimedPaths: string[] = [];
      const staged = yield* Effect.gen(function* () {
        const entries = yield* Effect.forEach(bundle.entries, (entry) =>
          claimPendingAttachments({ threadId, attachments: entry.attachments }).pipe(
            Effect.provide(uploadContext),
            Effect.mapError(failure),
            Effect.map((claimed) => {
              claimedPaths.push(...claimed.claimedPaths);
              return { ...entry, attachments: claimed.attachments };
            }),
          ),
        );
        const token = yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError(() => invalid("Cannot allocate a fork commit token.")));
        const expiresAt = (yield* Clock.currentTimeMillis) + 10 * 60 * 1000;
        yield* transactions.write(key, {
          phase: "pending",
          token,
          expiresAt,
          bundle: { ...bundle, entries },
          projectId: rep.projectId,
          claimedPaths,
          limits,
        });
        yield* armExpiry(key, expiresAt);
        return { token, result };
      }).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            const fs = fileSystem;
            for (const path of claimedPaths)
              yield* fs.remove(path, { force: true }).pipe(Effect.orDie);
            yield* clearForkUploads(bundle.id).pipe(Effect.provide(uploadContext), Effect.orDie);
          }),
        ),
      );
      return staged;
    });
    const commitFork = Effect.fn("ThreadForkService.commitFork")(function* (
      forkId: string,
      token: string,
    ) {
      const key = `target:${forkId}`;
      const value = yield* transactions.read(key);
      if (
        !value ||
        value.phase === "outgoing" ||
        value.phase === "uploading" ||
        value.token !== token
      )
        return yield* invalid("The pending fork expired or its commit token is invalid.");
      if (value.phase === "committed") return value.result;
      if (value.phase === "pending" && value.expiresAt <= (yield* Clock.currentTimeMillis)) {
        yield* clearTransaction(key, value);
        return yield* invalid("The pending fork expired before commit.");
      }
      yield* transactions.write(key, { ...value, phase: "committing" });
      const result = yield* receiveFork(value.bundle, value.projectId).pipe(
        Effect.tapError((error) =>
          error.code === "invalid_request" ? clearTransaction(key, value) : Effect.void,
        ),
      );
      yield* clearForkUploads(forkId).pipe(Effect.provide(uploadContext));
      yield* transactions.write(key, { phase: "committed", token, result });
      return result;
    });
    const receive: (
      input: ForkTransportInput,
      limits: PeerCallLimits,
    ) => Effect.Effect<typeof ForkTransportResult.Type, OrchestratorMcpFailure> = Effect.fn(
      "ThreadForkService.receive",
    )(function* (input: ForkTransportInput, limits: PeerCallLimits) {
      if (input.action === "catalog") {
        return {
          providers: (yield* providers.getProviders).map((provider) => ({
            ...provider,
            auth: { status: provider.auth.status },
          })),
        };
      }
      const key = `target:${input.action === "receive" ? input.bundle.id : input.forkId}`;
      return yield* locks.withLock(
        key,
        Effect.gen(function* () {
          if (input.action === "prepare") {
            const previous = yield* transactions.read(key);
            if (previous?.phase === "committed")
              return { token: previous.token, result: previous.result };
            if (previous?.phase === "pending" || previous?.phase === "committing")
              return yield* stageFork(previous.bundle, previous.limits);
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
          if (input.action === "upload") {
            const previous = yield* transactions.read(key);
            if (previous && previous.phase !== "uploading")
              return yield* invalid("The fork attachments have already been staged.");
            if (!previous) {
              const expiresAt = (yield* Clock.currentTimeMillis) + 10 * 60 * 1000;
              yield* transactions.write(key, {
                phase: "uploading",
                forkId: input.forkId,
                expiresAt,
              });
              yield* armExpiry(key, expiresAt);
            }
            return yield* receiveForkUpload(input).pipe(Effect.provide(uploadContext));
          }
          if (input.action === "commit") return yield* commitFork(input.forkId, input.token);
          if (input.action === "rollback") {
            const value = yield* transactions.read(key);
            if (value?.phase === "pending" || value?.phase === "uploading")
              yield* clearTransaction(key, value);
            else if (value === undefined)
              yield* clearForkUploads(input.forkId).pipe(Effect.provide(uploadContext));
            return { ok: true };
          }
          return yield* stageFork(input.bundle, limits);
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
          if (targetEnvironmentId !== self && !(yield* links.enabled))
            return yield* invalid("Enable mesh links before forking to another machine.");
          const callTarget = (args: ForkTransportInput) =>
            targetEnvironmentId === self
              ? receive(args, limits)
              : remote(targetEnvironmentId, args, limits);
          const prepared = yield* callTarget({
            action: "prepare",
            forkId: String(commandId),
            ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
            logicalKey,
            modelSelection,
          });
          let staged = "token" in prepared ? prepared : undefined;
          if (!staged) {
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
            const result = yield* callTarget({
              action: "receive",
              bundle: { ...bundle, entries: copied },
            });
            if (!("token" in result))
              return yield* invalid("The target did not acknowledge the pending fork.");
            staged = result;
          }
          const intent: Extract<ForkTransactions.ForkTransaction, { phase: "outgoing" }> = {
            phase: "outgoing",
            forkId: String(commandId),
            token: staged.token,
            targetEnvironmentId,
            sourceThreadId: input.threadId,
            sourceTitle: frozen.thread.title,
            limits,
          };
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              yield* transactions.write(`source:${intent.forkId}`, intent);
              const worker = yield* finishOutgoing(intent).pipe(Effect.forkIn(serviceScope));
              return yield* restore(Fiber.join(worker));
            }),
          );
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
    const finishOutgoing = Effect.fn("ThreadForkService.finishOutgoing")(function* (
      intent: Extract<ForkTransactions.ForkTransaction, { phase: "outgoing" }>,
    ) {
      return yield* locks
        .withLock(
          `source:${intent.forkId}`,
          Effect.gen(function* () {
            const request = {
              action: "commit" as const,
              forkId: intent.forkId,
              token: intent.token,
            };
            const result = yield* retry(
              intent.targetEnvironmentId === self
                ? receive(request, intent.limits)
                : remote(intent.targetEnvironmentId, request, intent.limits),
            );
            if (!("threadId" in result) || !("title" in result))
              return yield* invalid("The target did not confirm the fork commit.");
            yield* retry(linkBack(intent.sourceThreadId, result, intent.sourceTitle));
            yield* transactions.remove(`source:${intent.forkId}`);
            return result;
          }),
        )
        .pipe(
          Effect.tapError((error) =>
            error.code !== "orchestration_error"
              ? transactions.remove(`source:${intent.forkId}`)
              : Effect.void,
          ),
        );
    });
    const recover = Effect.gen(function* () {
      for (const { key, value } of yield* transactions.list) {
        if (value.phase === "pending" || value.phase === "uploading") {
          yield* expire(key);
          yield* armExpiry(key, value.expiresAt);
        } else if (value.phase === "committing") {
          yield* retry(locks.withLock(key, commitFork(value.bundle.id, value.token))).pipe(
            Effect.forkIn(serviceScope),
          );
        } else if (value.phase === "outgoing") {
          yield* finishOutgoing(value).pipe(Effect.forkIn(serviceScope));
        }
      }
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
          const uploadInput = {
            action: "upload" as const,
            forkId,
            attachment,
            offset,
            data: Buffer.from(bytes.subarray(offset, offset + CHUNK)).toString("base64"),
            final: offset + CHUNK >= bytes.length,
          };
          const uploaded = yield* targetEnvironmentId === self
            ? receive(uploadInput, limits)
            : remote(targetEnvironmentId, uploadInput, limits);
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
    yield* forkParked(retry(recover));
    const catalog = Effect.fn("ThreadForkService.catalog")(function* (
      targetEnvironmentId: EnvironmentId,
    ) {
      const result = yield* (
        targetEnvironmentId === self
          ? receive(
              { action: "catalog" },
              { runtimeMode: "full-access", interactionMode: "default" },
            )
          : remote(
              targetEnvironmentId,
              { action: "catalog" },
              { runtimeMode: "full-access", interactionMode: "default" },
            )
      ).pipe(
        Effect.timeoutOption("30 seconds"),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(failure({ message: "The target model catalog did not answer in time." })),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (!("providers" in result))
        return yield* invalid("The target did not supply its model catalog.");
      return result;
    });
    return ThreadForkService.of({ fork, receive, catalog });
  }),
).pipe(Layer.provideMerge(ForkTransactions.layer));
