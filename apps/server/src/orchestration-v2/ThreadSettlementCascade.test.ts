import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import * as ThreadSettlementCascade from "./ThreadSettlementCascade.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-settlement-cascade-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(layerServerConfig),
      Layer.provide(layerPlatformTest),
    ),
  ),
);

const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by settlement cascade tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTest = Layer.mergeAll(RuntimeLayer.layer, RuntimeLayer.layerEventSink).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      readRepositoryIdentity: () => Effect.succeed(null),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(layerPlatformTest),
);

const PROJECT_ID = ProjectId.make("settlement-cascade-project");

const createProject = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  yield* projects.create({
    commandId: CommandId.make("settlement-cascade:project"),
    projectId: PROJECT_ID,
    title: "Settlement cascade",
    workspaceRoot: "/workspace/settlement-cascade",
  });
});

const createThread = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:cascade:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`settlement-cascade:create:${name}`),
      threadId,
      projectId: PROJECT_ID,
      title: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/worktrees/settlement-cascade",
    });
    return threadId;
  });

/** A subagent thread under `parentId`, the way an adapter or a delegated task records one. */
const createSubagent = (
  parentId: ThreadId,
  name: string,
  options: {
    readonly origin?: "provider_native" | "app_owned";
    readonly running?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const parent = (yield* orchestrator.getThreadRecords(parentId, [])).thread;
    const childId = ThreadId.make(`thread:cascade:${name}`);
    const nodeId = NodeId.make(`node:cascade:${name}`);
    const runId = RunId.make(`run:cascade:${name}`);
    yield* eventSink.write({
      commandId: CommandId.make(`settlement-cascade:subagent:${name}`),
      events: [
        {
          id: EventId.make(`event:cascade:${name}:created`),
          type: "thread.created",
          threadId: childId,
          occurredAt: now,
          payload: makeSubagentChildThread({
            parentThread: parent,
            childThreadId: childId,
            parentNodeId: nodeId,
            activeProviderThreadId: null,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            title: name,
            now,
            createdBy: "agent",
            creationSource: "server",
          }),
        },
        {
          id: EventId.make(`event:cascade:${name}:subagent`),
          type: "subagent.updated",
          threadId: parentId,
          nodeId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId: parentId,
            runId: null,
            parentNodeId: NodeId.make(`node:cascade:${parentId}:root`),
            origin: options.origin ?? "provider_native",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId: childId,
            nativeTaskRef: null,
            prompt: `Work on ${name}.`,
            title: name,
            model: null,
            status: options.running ? "running" : "completed",
            result: null,
            startedAt: now,
            completedAt: options.running ? null : now,
            updatedAt: now,
          },
        },
        ...(options.running
          ? [
              {
                id: EventId.make(`event:cascade:${name}:run`),
                type: "run.updated" as const,
                threadId: childId,
                runId,
                occurredAt: now,
                payload: {
                  id: runId,
                  threadId: childId,
                  ordinal: 1,
                  providerInstanceId: modelSelection.instanceId,
                  modelSelection,
                  providerThreadId: null,
                  userMessageId: MessageId.make(`message:cascade:${name}`),
                  rootNodeId: null,
                  activeAttemptId: null,
                  status: "running" as const,
                  requestedAt: now,
                  startedAt: now,
                  completedAt: null,
                  checkpointId: null,
                  contextHandoffId: null,
                },
              },
            ]
          : []),
      ],
    });
    return childId;
  });

/**
 * Starts the cascade on every committed event from the start of the store, so
 * nothing committed before its subscription is missed.
 */
const startCascade = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const cascade = yield* ThreadSettlementCascade.make.pipe(
    Effect.provideService(Orchestrator.OrchestratorV2, {
      ...orchestrator,
      streamDomainEvents: orchestrator.streamStoredEvents.pipe(
        Stream.map((stored) => stored.event),
      ),
    }),
  );
  yield* cascade.start();
  return cascade;
});

/** Waits for the thread's first persisted event of this type. */
const awaitEvent = (threadId: ThreadId, eventType: OrchestrationV2DomainEvent["type"]) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator
      .streamStoredEventsFrom({ threadId, afterSequence: 0, eventType })
      .pipe(Stream.runHead, Effect.flatMap(Effect.fromOption)),
  );

const threadOf = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadRecords(threadId, []).pipe(Effect.map((records) => records.thread)),
  );

const settle = (threadId: ThreadId, id: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make(`settlement-cascade:settle:${id}`),
      threadId,
    }),
  );

describe("ThreadSettlementCascadeV2", () => {
  it.effect("settling a thread settles its subagents and theirs", () =>
    Effect.gen(function* () {
      yield* createProject;
      const parent = yield* createThread("parent");
      const child = yield* createSubagent(parent, "child");
      const task = yield* createSubagent(parent, "task", { origin: "app_owned" });
      const grandchild = yield* createSubagent(child, "grandchild");
      const cascade = yield* startCascade;

      yield* settle(parent, "parent");
      yield* awaitEvent(grandchild, "thread.settled");
      yield* cascade.drain;

      for (const threadId of [parent, child, task, grandchild]) {
        assert.equal((yield* threadOf(threadId)).settledOverride, "settled", threadId);
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("an automatic settlement settles the subagents too", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createProject;
      const parent = yield* createThread("parent");
      const child = yield* createSubagent(parent, "child");
      const cascade = yield* startCascade;

      yield* orchestrator.dispatch({
        type: "thread.auto-settle",
        commandId: CommandId.make("settlement-cascade:auto-settle"),
        threadId: parent,
        snapshotAt: (yield* threadOf(parent)).updatedAt,
      });
      yield* awaitEvent(child, "thread.settled");
      yield* cascade.drain;

      assert.equal((yield* threadOf(child)).settledOverride, "settled");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("a subagent that is still running stays active while the others settle", () =>
    Effect.gen(function* () {
      yield* createProject;
      const parent = yield* createThread("parent");
      const running = yield* createSubagent(parent, "running", {
        origin: "app_owned",
        running: true,
      });
      const runningChild = yield* createSubagent(running, "running-child");
      const done = yield* createSubagent(parent, "done");
      const doneChild = yield* createSubagent(done, "done-child");
      const cascade = yield* startCascade;

      yield* settle(parent, "parent");
      // The running subagent is visited first, so its refusal is in by now.
      yield* awaitEvent(doneChild, "thread.settled");
      yield* cascade.drain;

      assert.equal((yield* threadOf(done)).settledOverride, "settled");
      assert.equal((yield* threadOf(doneChild)).settledOverride, "settled");
      const left = yield* threadOf(running);
      assert.isNull(left.settledOverride);
      assert.isNull(left.settledAt);
      // Its own subagents stay with it until it settles.
      assert.isNull((yield* threadOf(runningChild)).settledOverride);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("settling again reaches a subagent that was still running the first time", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      yield* createProject;
      const parent = yield* createThread("parent");
      const child = yield* createSubagent(parent, "child");
      const straggler = yield* createSubagent(child, "straggler", { running: true });
      const marker = yield* createThread("marker");
      const markerChild = yield* createSubagent(marker, "marker-child");
      const cascade = yield* startCascade;

      yield* settle(child, "child");
      // Events cascade in order: once the marker's subagent settles, the
      // straggler has refused the child's cascade.
      yield* settle(marker, "marker");
      yield* awaitEvent(markerChild, "thread.settled");
      assert.isNull((yield* threadOf(straggler)).settledOverride);

      const run = (yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
        orchestrator.getThreadRecords(straggler, ["runs"]),
      )).runs[0]!;
      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make("settlement-cascade:straggler-done"),
        events: [
          {
            id: EventId.make("event:cascade:straggler-done"),
            type: "run.updated",
            threadId: straggler,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
      // The child is settled already, so the cascade walks through it.
      yield* settle(parent, "parent");
      yield* awaitEvent(straggler, "thread.settled");
      yield* cascade.drain;

      assert.equal((yield* threadOf(straggler)).settledOverride, "settled");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("un-settling a thread un-settles its settled subagents, not archived ones", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createProject;
      const parent = yield* createThread("parent");
      const child = yield* createSubagent(parent, "child");
      const archived = yield* createSubagent(parent, "archived");
      const grandchild = yield* createSubagent(child, "grandchild");
      const cascade = yield* startCascade;

      yield* settle(parent, "parent");
      yield* awaitEvent(grandchild, "thread.settled");
      yield* awaitEvent(archived, "thread.settled");
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("settlement-cascade:archive"),
        threadId: archived,
      });
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("settlement-cascade:unsettle"),
        threadId: parent,
        reason: "user",
      });
      yield* awaitEvent(grandchild, "thread.unsettled");
      yield* cascade.drain;

      for (const threadId of [parent, child, grandchild]) {
        const thread = yield* threadOf(threadId);
        assert.equal(thread.settledOverride, "active", threadId);
        assert.isNull(thread.settledAt, threadId);
      }
      const stillArchived = yield* threadOf(archived);
      assert.isNotNull(stillArchived.archivedAt);
      assert.equal(stillArchived.settledOverride, "settled");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("settling a subagent leaves its parent alone", () =>
    Effect.gen(function* () {
      yield* createProject;
      const parent = yield* createThread("parent");
      const child = yield* createSubagent(parent, "child");
      const marker = yield* createThread("marker");
      const markerChild = yield* createSubagent(marker, "marker-child");
      const cascade = yield* startCascade;

      yield* settle(child, "child");
      // Events cascade in order: once the marker's subagent settles, the
      // child's settlement has been handled.
      yield* settle(marker, "marker");
      yield* awaitEvent(markerChild, "thread.settled");
      yield* cascade.drain;

      assert.equal((yield* threadOf(child)).settledOverride, "settled");
      assert.isNull((yield* threadOf(parent)).settledOverride);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
