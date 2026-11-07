import * as Schema from "effect/Schema";
import {
  DELIVERY_UPDATING,
  DeliveryDrainError,
  type DeliveryDrainInput,
  type DeliveryDrainStatus,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

const isDrainError = Schema.is(DeliveryDrainError);
const decodeRunIds = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeRunIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeStart = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ runId: Schema.String })),
);

export class DeliveryAdmission extends Context.Service<
  DeliveryAdmission,
  {
    readonly drain: (
      input: typeof DeliveryDrainInput.Type,
    ) => Effect.Effect<typeof DeliveryDrainStatus.Type, DeliveryDrainError>;
    readonly cancel: (
      requestId: string,
    ) => Effect.Effect<typeof DeliveryDrainStatus.Type, DeliveryDrainError>;
    readonly onOpen: (resume: Effect.Effect<void>) => Effect.Effect<void>;
    readonly status: Effect.Effect<typeof DeliveryDrainStatus.Type, DeliveryDrainError>;
    readonly deferredRunIds: Effect.Effect<ReadonlySet<string>, DeliveryDrainError>;
    readonly guard: (
      events: ReadonlyArray<OrchestrationV2DomainEvent>,
      starts?: ReadonlyArray<string>,
    ) => Effect.Effect<void, DeliveryDrainError>;
    readonly withStart: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | DeliveryDrainError, R>;
    readonly awaitClosed: Effect.Effect<void, DeliveryDrainError>;
    readonly notify: Effect.Effect<void>;
  }
>()("t3/mesh/DeliveryAdmission") {}

export const layer = Layer.effect(
  DeliveryAdmission,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS delivery_admission (id INTEGER PRIMARY KEY CHECK(id = 1), request_id TEXT NOT NULL, deadline_at INTEGER NOT NULL, deferred_json TEXT NOT NULL)`;
    const resumeQueued = yield* Ref.make(Effect.void);
    const changed = yield* Ref.make(yield* Deferred.make<void>());
    const startLock = yield* Semaphore.make(1);
    const mapError = (cause: unknown) =>
      isDrainError(cause) ? cause : new DeliveryDrainError({ message: String(cause) });
    const notify = Effect.gen(function* () {
      const next = yield* Deferred.make<void>();
      yield* Deferred.succeed(yield* Ref.getAndSet(changed, next), undefined);
    });
    const read = sql<{
      request_id: string;
      deadline_at: number;
      deferred_json: string;
    }>`SELECT * FROM delivery_admission WHERE id = 1`;
    const deferredRunIds = Effect.gen(function* () {
      const rows = yield* read;
      return new Set<string>(rows[0] ? yield* decodeRunIds(rows[0].deferred_json) : []);
    }).pipe(Effect.mapError(mapError));
    const status = Effect.gen(function* () {
      const row = (yield* read)[0];
      if (!row)
        return {
          requestId: null,
          phase: "open" as const,
          deadlineAt: null,
          activeRuns: 0,
          pendingStarts: 0,
        };
      const deferred = new Set<string>(yield* decodeRunIds(row.deferred_json));
      const rows = yield* sql<{
        run_id: string;
      }>`SELECT run_id FROM orchestration_v2_projection_runs WHERE status IN ('preparing','starting','running','waiting') UNION SELECT run_id FROM orchestration_v2_projection_nodes WHERE status IN ('pending','starting','running','waiting')`;
      const activeRuns = rows.filter((run) => !deferred.has(run.run_id)).length;
      return {
        requestId: row.request_id,
        phase: activeRuns === 0 ? ("drained" as const) : ("draining" as const),
        deadlineAt: row.deadline_at,
        activeRuns,
        pendingStarts: deferred.size,
      };
    }).pipe(Effect.mapError(mapError));
    const cancel = Effect.fn("DeliveryAdmission.cancel")(function* (requestId: string) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const row = (yield* read)[0];
            if (row && row.request_id !== requestId)
              return yield* new DeliveryDrainError({ message: "Another delivery owns admission" });
            yield* sql`DELETE FROM delivery_admission WHERE id = 1`;
          }),
        )
        .pipe(Effect.mapError(mapError));
      yield* notify;
      yield* yield* Ref.get(resumeQueued);
      return yield* status;
    });
    const awaitOpen: Effect.Effect<void, DeliveryDrainError> = Effect.suspend(() =>
      Effect.gen(function* () {
        const signal = yield* Ref.get(changed);
        if ((yield* status).phase === "open") return;
        yield* Deferred.await(signal);
        return yield* awaitOpen;
      }),
    );
    const withStart = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | DeliveryDrainError, R> =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          yield* awaitOpen;
          const result = yield* startLock.withPermits(1)(
            Effect.gen(function* () {
              if ((yield* status).phase !== "open") return { closed: true as const };
              return { closed: false as const, value: yield* effect };
            }),
          );
          return result.closed ? yield* withStart(effect) : result.value;
        }),
      );
    const drain = Effect.fn("DeliveryAdmission.drain")(function* (
      input: typeof DeliveryDrainInput.Type,
    ) {
      const deadlineAt = DateTime.toEpochMillis(yield* DateTime.now) + input.deadlineMs;
      const wait = Effect.gen(function* () {
        yield* startLock
          .withPermits(1)(
            sql.withTransaction(
              Effect.gen(function* () {
                const existing = (yield* read)[0];
                if (existing) {
                  if (existing.request_id !== input.requestId)
                    return yield* new DeliveryDrainError({
                      message: "Another delivery owns admission",
                    });
                  return;
                }
                const effects = yield* sql<{
                  payload_json: string;
                }>`SELECT effect.payload_json FROM orchestration_v2_effect_outbox effect JOIN orchestration_v2_projection_runs run ON run.run_id = json_extract(effect.payload_json, '$.runId') WHERE effect.status IN ('pending','running') AND effect.effect_type IN ('provider-turn.start','provider-turn.restart') AND run.status IN ('preparing','starting')`;
                const runs = yield* Effect.forEach(effects, (row) =>
                  decodeStart(row.payload_json).pipe(Effect.map((value) => value.runId)),
                );
                yield* sql`INSERT INTO delivery_admission (id, request_id, deadline_at, deferred_json) VALUES (1, ${input.requestId}, ${deadlineAt}, ${yield* encodeRunIds(runs)})`;
              }),
            ),
          )
          .pipe(Effect.mapError(mapError));
        yield* notify;
        const loop: Effect.Effect<typeof DeliveryDrainStatus.Type, DeliveryDrainError> =
          Effect.suspend(() =>
            Effect.gen(function* () {
              const signal = yield* Ref.get(changed);
              const current = yield* status;
              if (current.requestId !== input.requestId)
                return yield* new DeliveryDrainError({ message: "Drain was cancelled" });
              if (current.phase === "drained") return current;
              yield* Deferred.await(signal);
              return yield* loop;
            }),
          );
        return yield* loop;
      });
      return yield* wait.pipe(
        Effect.timeoutOrElse({
          duration: input.deadlineMs,
          orElse: () =>
            Effect.fail(
              new DeliveryDrainError({ message: "Drain deadline exceeded; server stays running" }),
            ),
        }),
        Effect.onError(() =>
          status.pipe(
            Effect.flatMap((current) =>
              current.requestId === input.requestId
                ? cancel(input.requestId).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.orDie,
          ),
        ),
      );
    });
    const guard = Effect.fn("DeliveryAdmission.guard")(function* (
      events: ReadonlyArray<OrchestrationV2DomainEvent>,
    ) {
      if (!(yield* read)[0]) return;
      for (const event of events) {
        if (
          (event.type !== "run.created" && event.type !== "run.updated") ||
          !["preparing", "starting", "running"].includes(event.payload.status)
        )
          continue;
        const previous = yield* sql<{
          status: string;
        }>`SELECT status FROM orchestration_v2_projection_runs WHERE run_id = ${event.payload.id}`;
        if (
          !previous[0] ||
          !["preparing", "starting", "running", "waiting"].includes(previous[0].status)
        )
          return yield* new DeliveryDrainError({
            message: `${DELIVERY_UPDATING}: server is draining; retry this command`,
          });
      }
    }, Effect.mapError(mapError));
    const awaitClosed: Effect.Effect<void, DeliveryDrainError> = Effect.suspend(() =>
      Effect.gen(function* () {
        const signal = yield* Ref.get(changed);
        if ((yield* status).phase !== "open") return;
        yield* Deferred.await(signal);
        return yield* awaitClosed;
      }),
    );
    return DeliveryAdmission.of({
      onOpen: Effect.fn("DeliveryAdmission.onOpen")((resume) => Ref.set(resumeQueued, resume)),
      awaitClosed,
      drain,
      cancel,
      status,
      deferredRunIds,
      guard,
      withStart,
      notify,
    });
  }),
);
