import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Ref from "effect/Ref";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProviderInstanceId,
  ProjectId,
  RunId,
  ThreadId,
  isDeliveryUpdating,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Admission from "./DeliveryAdmission.ts";
import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";

const layer = Layer.mergeAll(EventSink.layer, Outbox.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(EventStore.layer, Projections.layer)),
  Layer.provideMerge(Admission.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);
const event = Effect.fn("DeliveryTest.run")(function* (
  name: string,
  status: "starting" | "running",
) {
  const now = yield* DateTime.now;
  const id = RunId.make(name);
  const threadId = ThreadId.make(`thread:${name}`);
  yield* (yield* Projections.ProjectionStoreV2).apply({
    id: EventId.make(`thread-created:${name}`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      id: threadId,
      projectId: ProjectId.make("delivery-project"),
      title: name,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      createdBy: "user",
      creationSource: "web",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  return {
    id: EventId.make(`event:${name}`),
    type: "run.created",
    threadId,
    runId: id,
    occurredAt: now,
    payload: {
      id,
      threadId,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${name}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  } satisfies OrchestrationV2DomainEvent;
});

it.effect("atomically refuses a turn committed during drain and keeps the existing run alive", () =>
  Effect.gen(function* () {
    const admission = yield* Admission.DeliveryAdmission;
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* Projections.ProjectionStoreV2;
    const active = yield* event("active", "running");
    yield* projections.apply(active);
    const draining = yield* admission
      .drain({ requestId: "delivery", deadlineMs: 10000 })
      .pipe(Effect.forkChild);
    yield* admission.awaitClosed;
    const next = yield* event("next", "starting");
    const failure = yield* sink.write({ events: [next] }).pipe(Effect.flip);
    assert.isTrue(isDeliveryUpdating(failure));
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(yield* sql`SELECT run_id FROM orchestration_v2_projection_runs`, [
      { run_id: "active" },
    ]);
    yield* sink.write({
      events: [
        {
          ...active,
          id: EventId.make("active-completed"),
          type: "run.updated",
          payload: { ...active.payload, status: "completed", completedAt: yield* DateTime.now },
        },
      ],
    });
    assert.equal((yield* Fiber.join(draining)).phase, "drained");
    yield* admission.cancel("delivery");
    yield* sink.write({ events: [next] });
  }).pipe(Effect.provide(layer)),
);

it.effect("deadline keeps a long active turn running and reopens admission", () =>
  Effect.gen(function* () {
    const admission = yield* Admission.DeliveryAdmission;
    const projection = yield* Projections.ProjectionStoreV2;
    yield* projection.apply(yield* event("long", "running"));
    const fiber = yield* admission
      .drain({ requestId: "deadline", deadlineMs: 1000 })
      .pipe(Effect.forkChild);
    yield* admission.awaitClosed;
    yield* TestClock.adjust("1 second");
    assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
    assert.equal((yield* admission.status).phase, "open");
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(
      yield* sql`SELECT status FROM orchestration_v2_projection_runs WHERE run_id = 'long'`,
      [{ status: "running" }],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "preserves accepted starts across restart and delivers once cancellation opens admission",
  () =>
    Effect.gen(function* () {
      const admission = yield* Admission.DeliveryAdmission;
      const projections = yield* Projections.ProjectionStoreV2;
      const outbox = yield* Outbox.EffectOutboxV2;
      const pending = yield* event("pending", "starting");
      yield* projections.apply(pending);
      yield* outbox.enqueue([
        {
          id: "pending-effect",
          commandId: CommandId.make("pending-command"),
          threadId: pending.threadId,
          request: { type: "provider-turn.start", runId: pending.payload.id },
        },
      ]);
      assert.equal(
        (yield* admission.drain({ requestId: "restart", deadlineMs: 1000 })).pendingStarts,
        1,
      );
      const sql = yield* SqlClient.SqlClient;
      const context = yield* Layer.build(Admission.layer).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      const restarted = Context.get(context, Admission.DeliveryAdmission);
      assert.equal((yield* restarted.status).phase, "drained");
      yield* outbox.reconcileAfterProcessLoss;
      const rows =
        yield* sql`SELECT status FROM orchestration_v2_effect_outbox WHERE effect_id = 'pending-effect'`;
      assert.deepEqual(rows, [{ status: "pending" }]);
      const newOutboxContext = yield* Layer.build(Outbox.layer).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(Admission.DeliveryAdmission, restarted),
      );
      const newOutbox = Context.get(newOutboxContext, Outbox.EffectOutboxV2);
      const delivered = yield* Ref.make(0);
      const workerContext = yield* Layer.build(
        EffectWorker.layerWithOptions({ workerId: "restarted-worker" }),
      ).pipe(
        Effect.provideService(Outbox.EffectOutboxV2, newOutbox),
        Effect.provideService(EffectWorker.OrchestrationEffectExecutorV2, {
          execute: () =>
            restarted.withStart(Ref.update(delivered, (count) => count + 1)).pipe(
              Effect.mapError(
                (cause) =>
                  new EffectWorker.OrchestrationEffectExecutionError({
                    effectId: "pending-effect",
                    effectType: "provider-turn.start",
                    cause,
                  }),
              ),
            ),
        }),
      );
      const worker = Context.get(workerContext, EffectWorker.OrchestrationEffectWorkerV2);
      assert.isFalse(yield* worker.runOnce);
      const awakened = yield* worker.awaitWork.pipe(Effect.forkChild);
      yield* restarted.cancel("restart");
      yield* Fiber.join(awakened);
      assert.isTrue(yield* worker.runOnce);
      assert.isFalse(yield* worker.runOnce);
      assert.equal(yield* Ref.get(delivered), 1);
      yield* restarted.cancel("restart");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("a provider start racing closure cannot cross the admission mutex", () =>
  Effect.gen(function* () {
    const admission = yield* Admission.DeliveryAdmission;
    const firstEntered = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const nextAttempted = yield* Deferred.make<void>();
    const nextDelivered = yield* Deferred.make<void>();
    const first = yield* admission
      .withStart(
        Deferred.succeed(firstEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(firstEntered);
    const drain = yield* admission
      .drain({ requestId: "start-race", deadlineMs: 1000 })
      .pipe(Effect.forkChild);
    const next = yield* Deferred.succeed(nextAttempted, undefined).pipe(
      Effect.andThen(admission.withStart(Deferred.succeed(nextDelivered, undefined))),
      Effect.forkChild,
    );
    yield* Deferred.await(nextAttempted);
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(first);
    assert.equal((yield* Fiber.join(drain)).phase, "drained");
    assert.isFalse(yield* Deferred.isDone(nextDelivered));
    const refusal = yield* Fiber.join(next).pipe(Effect.flip);
    assert.isTrue(isDeliveryUpdating(refusal));
    yield* admission.cancel("start-race");
    yield* admission.withStart(Deferred.succeed(nextDelivered, undefined));
    assert.isTrue(yield* Deferred.isDone(nextDelivered));
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a start claimed exactly before closure is requeued without exhausting its retry budget",
  () =>
    Effect.gen(function* () {
      const admission = yield* Admission.DeliveryAdmission;
      const projections = yield* Projections.ProjectionStoreV2;
      const outbox = yield* Outbox.EffectOutboxV2;
      const pending = yield* event("claim-race", "starting");
      yield* projections.apply(pending);
      yield* outbox.enqueue([
        {
          id: "claim-race-effect",
          commandId: CommandId.make("claim-race-command"),
          threadId: pending.threadId,
          request: { type: "provider-turn.start", runId: pending.payload.id },
        },
      ]);
      const first = yield* Ref.make(true);
      const delivered = yield* Ref.make(0);
      const context = yield* Layer.build(
        EffectWorker.layerWithOptions({ workerId: "claim-race-worker", maxAttempts: 1 }),
      ).pipe(
        Effect.provideService(Outbox.EffectOutboxV2, outbox),
        Effect.provideService(EffectWorker.OrchestrationEffectExecutorV2, {
          execute: () =>
            Effect.gen(function* () {
              if (yield* Ref.getAndSet(first, false))
                yield* admission.drain({ requestId: "claim-race", deadlineMs: 1000 });
              yield* admission.withStart(Ref.update(delivered, (count) => count + 1));
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new EffectWorker.OrchestrationEffectExecutionError({
                    effectId: "claim-race-effect",
                    effectType: "provider-turn.start",
                    cause,
                  }),
              ),
            ),
        }),
      );
      const worker = Context.get(context, EffectWorker.OrchestrationEffectWorkerV2);
      assert.isTrue(yield* worker.runOnce);
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        yield* sql`SELECT status, attempt_count FROM orchestration_v2_effect_outbox WHERE effect_id = 'claim-race-effect'`,
        [{ status: "pending", attempt_count: 0 }],
      );
      assert.isFalse(yield* worker.runOnce);
      yield* admission.cancel("claim-race");
      assert.isTrue(yield* worker.runOnce);
      assert.isFalse(yield* worker.runOnce);
      assert.equal(yield* Ref.get(delivered), 1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "forced delivery still fences new starts while allowing interruption of the active run",
  () =>
    Effect.gen(function* () {
      const admission = yield* Admission.DeliveryAdmission;
      const projections = yield* Projections.ProjectionStoreV2;
      yield* projections.apply(yield* event("forced-active", "running"));
      const status = yield* admission.drain({ requestId: "forced", deadlineMs: 1000, now: true });
      assert.equal(status.phase, "draining");
      assert.equal(status.activeRuns, 1);
      const sink = yield* EventSink.EventSinkV2;
      const refused = yield* sink
        .write({ events: [yield* event("forced-next", "starting")] })
        .pipe(Effect.flip);
      assert.isTrue(isDeliveryUpdating(refused));
      yield* admission.cancel("forced");
    }).pipe(Effect.provide(layer)),
);
