import * as Schema from "effect/Schema";
import {
  DeliveryUpdatingError,
  isDeliveryUpdating,
  ADMISSION_GATED_EFFECT_TYPES,
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
    ) => Effect.Effect<void, DeliveryDrainError | DeliveryUpdatingError>;
    readonly withStart: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | DeliveryDrainError | DeliveryUpdatingError, R>;
    readonly awaitClosed: Effect.Effect<void, DeliveryDrainError | DeliveryUpdatingError>;
    readonly notify: Effect.Effect<void>;
  }
>()("t3/mesh/DeliveryAdmission") {}

export const layer = Layer.effect(
  DeliveryAdmission,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS delivery_admission (id INTEGER PRIMARY KEY CHECK(id = 1), request_id TEXT NOT NULL, deadline_at INTEGER NOT NULL, deferred_json TEXT NOT NULL)`;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const expired =
      yield* sql`DELETE FROM delivery_admission WHERE id = 1 AND deadline_at < ${now - 60_000} RETURNING id`;
    if (expired.length) yield* Effect.logWarning("Expired abandoned delivery admission on startup");
    const resumeQueued = yield* Ref.make<ReadonlyArray<Effect.Effect<void>>>([]);
    const changed = yield* Ref.make(yield* Deferred.make<void>());
    const startLock = yield* Semaphore.make(1);
    let activeStarts = 0;
    let startsIdle = Deferred.makeUnsafe<void>();
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
      yield* Effect.all(yield* Ref.get(resumeQueued), { discard: true });
      return yield* status;
    });
    const withStart = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | DeliveryDrainError | DeliveryUpdatingError, R> =>
      Effect.uninterruptibleMask((restore) =>
        restore(startLock.take(1)).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              if ((yield* status).phase !== "open") return yield* new DeliveryUpdatingError();
              if (activeStarts === 0) startsIdle = Deferred.makeUnsafe<void>();
              activeStarts++;
            }).pipe(Effect.ensuring(startLock.release(1))),
          ),
          Effect.flatMap(() =>
            restore(effect).pipe(
              Effect.ensuring(
                Effect.suspend(() => {
                  activeStarts--;
                  return activeStarts === 0
                    ? Deferred.succeed(startsIdle, undefined).pipe(Effect.asVoid)
                    : Effect.void;
                }),
              ),
            ),
          ),
        ),
      );
    const drain = Effect.fn("DeliveryAdmission.drain")(function* (
      input: typeof DeliveryDrainInput.Type,
    ) {
      const deadlineAt = DateTime.toEpochMillis(yield* DateTime.now) + input.deadlineMs;
      const wait = Effect.gen(function* () {
        yield* startLock
          .withPermits(1)(
            Effect.gen(function* () {
              if (activeStarts > 0) yield* Deferred.await(startsIdle);
              return yield* sql.withTransaction(
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
                  }>`SELECT effect.payload_json FROM orchestration_v2_effect_outbox effect JOIN orchestration_v2_projection_runs run ON run.run_id = json_extract(effect.payload_json, '$.runId') WHERE effect.status IN ('pending','running') AND effect.effect_type IN ${sql.in([...ADMISSION_GATED_EFFECT_TYPES])} AND run.status IN ('preparing','starting')`;
                  const runs = yield* Effect.forEach(effects, (row) =>
                    decodeStart(row.payload_json).pipe(Effect.map((value) => value.runId)),
                  );
                  yield* sql`INSERT INTO delivery_admission (id, request_id, deadline_at, deferred_json) VALUES (1, ${input.requestId}, ${deadlineAt}, ${yield* encodeRunIds(runs)})`;
                }),
              );
            }),
          )
          .pipe(Effect.mapError(mapError));
        yield* notify;
        if (input.now === true) return yield* status;
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
            Effect.catchCause((cause) =>
              Effect.logError("Failed to reopen delivery admission after drain failure", cause),
            ),
          ),
        ),
      );
    });
    const guard = Effect.fn("DeliveryAdmission.guard")(
      function* (
        events: ReadonlyArray<OrchestrationV2DomainEvent>,
        starts: ReadonlyArray<string> = [],
      ) {
        if (!(yield* read)[0]) return;
        const runIds = new Set(starts);
        for (const event of events) {
          if (
            (event.type === "run.created" || event.type === "run.updated") &&
            ["preparing", "starting", "running"].includes(event.payload.status)
          )
            runIds.add(event.payload.id);
        }
        if (!runIds.size) return;
        const rows = yield* sql<{
          run_id: string;
          status: string;
        }>`SELECT run_id, status FROM orchestration_v2_projection_runs WHERE run_id IN ${sql.in([...runIds])}`;
        const admitted = new Set(
          rows
            .filter((row) => ["preparing", "starting", "running", "waiting"].includes(row.status))
            .map((row) => row.run_id),
        );
        if ([...runIds].some((id) => !admitted.has(id))) return yield* new DeliveryUpdatingError();
      },
      Effect.mapError((cause) =>
        isDeliveryUpdating(cause) ? new DeliveryUpdatingError() : mapError(cause),
      ),
    );
    const awaitClosed: Effect.Effect<void, DeliveryDrainError> = Effect.suspend(() =>
      Effect.gen(function* () {
        const signal = yield* Ref.get(changed);
        if ((yield* status).phase !== "open") return;
        yield* Deferred.await(signal);
        return yield* awaitClosed;
      }),
    );
    return DeliveryAdmission.of({
      onOpen: Effect.fn("DeliveryAdmission.onOpen")((resume) =>
        Ref.update(resumeQueued, (callbacks) => [...callbacks, resume]),
      ),
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
