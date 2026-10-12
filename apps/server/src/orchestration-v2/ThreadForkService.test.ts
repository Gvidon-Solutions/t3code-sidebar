import { assert, it } from "@effect/vitest";
import {
  ContextTransferId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ThreadForkService from "./ThreadForkService.ts";

const sourceThreadId = ThreadId.make("thread:fork-snoozed-source");
const targetThreadId = ThreadId.make("thread:fork-awake-target");
const sourceRunId = RunId.make("run:fork-snoozed-source");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const sourceCreatedAt = DateTime.makeUnsafe("2026-07-24T09:00:00.000Z");
const snoozedAt = DateTime.makeUnsafe("2026-07-24T09:05:00.000Z");
const snoozedUntil = DateTime.makeUnsafe("2026-07-25T09:00:00.000Z");
const forkCreatedAt = DateTime.makeUnsafe("2026-07-24T09:10:00.000Z");

function makeSourceThread(
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: sourceThreadId,
    projectId: ProjectId.make("project:fork-snooze"),
    title: "Snoozed source",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/source",
    worktreePath: "/tmp/source-worktree",
    activeProviderThreadId: ProviderThreadId.make("provider-thread:fork-snoozed-source"),
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: sourceThreadId,
    },
    forkedFrom: null,
    createdAt: sourceCreatedAt,
    updatedAt: snoozedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil,
    snoozedAt,
    deletedAt: null,
    ...overrides,
  };
}

function makeSourceRun(status: OrchestrationV2Run["status"]): OrchestrationV2Run {
  return {
    id: sourceRunId,
    threadId: sourceThreadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: ProviderThreadId.make("provider-thread:fork-snoozed-source"),
    userMessageId: MessageId.make("message:fork-snoozed-source"),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    queuePosition: null,
    requestedAt: sourceCreatedAt,
    startedAt: sourceCreatedAt,
    completedAt: snoozedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function makeSourceProjection(
  sourceRun: OrchestrationV2Run,
  thread = makeSourceThread(),
): OrchestrationV2ThreadProjection {
  return {
    thread,
    runs: [sourceRun],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: snoozedAt,
  };
}

const planFork = (sourceRun: OrchestrationV2Run, sourceThread = makeSourceThread()) =>
  Effect.gen(function* () {
    const service = yield* ThreadForkService.ThreadForkServiceV2;
    return yield* service.plan({
      sourceProjection: makeSourceProjection(sourceRun, sourceThread),
      sourceRun,
      sourceProviderThread: undefined,
      canonicalSourcePoint: {
        threadId: sourceThreadId,
        runId: sourceRunId,
      },
      transferId: ContextTransferId.make("context-transfer:fork-snoozed-source"),
      targetThreadId,
      title: "Awake fork",
      createdBy: "user",
      creationSource: "mobile",
      createdAt: forkCreatedAt,
    });
  }).pipe(Effect.provide(ThreadForkService.layer));

it("treats usage-limited and other provider-finished runs as forkable", () => {
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("completed"));
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("waiting"));
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("failed"));
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("interrupted"));
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("cancelled"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("running"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("starting"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("queued"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("preparing"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("rolled_back"));
});

it.effect("keeps a fork awake when its source thread is snoozed", () =>
  Effect.gen(function* () {
    const sourceThread = makeSourceThread();
    const sourceRun = makeSourceRun("completed");
    const result = yield* planFork(sourceRun);

    assert.isNull(result.targetThread.snoozedUntil);
    assert.isNull(result.targetThread.snoozedAt);
    assert.equal(result.targetThread.projectId, sourceThread.projectId);
    assert.equal(result.targetThread.providerInstanceId, sourceThread.providerInstanceId);
    assert.deepEqual(result.targetThread.modelSelection, sourceThread.modelSelection);
    assert.equal(result.targetThread.runtimeMode, sourceThread.runtimeMode);
    assert.equal(result.targetThread.interactionMode, sourceThread.interactionMode);
    assert.equal(result.targetThread.branch, sourceThread.branch);
    assert.equal(result.targetThread.worktreePath, sourceThread.worktreePath);
    assert.isNull(result.targetThread.activeProviderThreadId);
    assert.deepEqual(result.targetThread.lineage, {
      parentThreadId: sourceThreadId,
      relationshipToParent: "fork",
      rootThreadId: sourceThreadId,
    });
    assert.deepEqual(result.targetThread.forkedFrom, {
      type: "run",
      threadId: sourceThreadId,
      runId: sourceRunId,
    });
  }),
);

it.effect("never pins a fork of a pinned thread", () =>
  Effect.gen(function* () {
    const result = yield* planFork(
      makeSourceRun("completed"),
      makeSourceThread({ pinnedAt: snoozedAt, pinOrderKey: "m" }),
    );
    assert.isNull(result.targetThread.pinnedAt);
    assert.isNull(result.targetThread.pinOrderKey);
  }),
);

it.effect("forks from a usage-limited failed run", () =>
  Effect.gen(function* () {
    const result = yield* planFork(makeSourceRun("failed"));
    assert.deepEqual(result.targetThread.forkedFrom, {
      type: "run",
      threadId: sourceThreadId,
      runId: sourceRunId,
    });
  }),
);

it.effect("rejects in-progress and rolled-back fork sources", () =>
  Effect.gen(function* () {
    for (const status of ["running", "rolled_back"] as const) {
      const sourceRun = makeSourceRun(status);
      const error = yield* planFork(sourceRun).pipe(Effect.flip);
      assert.equal(error._tag, "ThreadForkPlanError");
      assert.equal(error.sourceThreadId, sourceThreadId);
      assert.equal(error.targetThreadId, targetThreadId);
      assert.equal(error.cause, ThreadForkService.forkableSourceRunStatusError(sourceRun));
    }
  }),
);

it("copies the history of an imported thread that has no runs", () => {
  const at = DateTime.makeUnsafe("2026-07-24T09:00:00.000Z");
  const userMessageId = MessageId.make("message:legacy-user");
  const common = {
    threadId: sourceThreadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const plan = ThreadForkService.planLegacyImportFork({
    sourceThread: makeSourceThread({ historyOrigin: "v1_import", pinnedAt: at }),
    messages: [
      {
        createdBy: "user",
        creationSource: "server",
        id: userMessageId,
        threadId: sourceThreadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: "hello",
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    ],
    turnItems: [
      {
        ...common,
        id: TurnItemId.make("item:legacy-user"),
        ordinal: 1,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        messageId: userMessageId,
        inputIntent: "turn_start",
        text: "hello",
        attachments: [],
      },
      {
        ...common,
        id: TurnItemId.make("item:v2-run"),
        runId: sourceRunId,
        ordinal: 2,
        type: "assistant_message",
        messageId: MessageId.make("message:v2-run"),
        text: "not copied",
        streaming: false,
      },
    ],
    targetThreadId,
    title: "Snoozed source (1)",
    createdBy: "user",
    creationSource: "mobile",
    createdAt: forkCreatedAt,
  });

  assert.equal(plan.targetThread.id, targetThreadId);
  assert.equal(plan.targetThread.title, "Snoozed source (1)");
  assert.equal(plan.targetThread.historyOrigin, "v1_import");
  assert.isNull(plan.targetThread.pinnedAt);
  assert.deepEqual(plan.targetThread.lineage, {
    parentThreadId: sourceThreadId,
    relationshipToParent: "fork",
    rootThreadId: sourceThreadId,
  });
  assert.equal(plan.messages.length, 1);
  assert.equal(plan.messages[0]!.threadId, targetThreadId);
  assert.notEqual(plan.messages[0]!.id, userMessageId);
  assert.equal(plan.turnItems.length, 1);
  const item = plan.turnItems[0]!;
  assert.equal(item.threadId, targetThreadId);
  assert.equal(item.type === "user_message" ? item.messageId : null, plan.messages[0]!.id);
});
