import { MeshConfigDocument, MeshConfigError, MeshConfigRevision } from "@t3tools/contracts";
import { parseConfig, referenceErrors } from "@t3tools/shared/meshConfig";
import type { Json, MeshLayoutDocument } from "@t3tools/shared/meshLayout";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Scope from "effect/Scope";
import { MeshLayoutService } from "./MeshLayoutService.ts";

export interface ConfigAction {
  readonly id: string;
  readonly server: string;
  readonly description: string;
}
export interface ConfigPlanner {
  readonly name: string;
  readonly plan: (
    doc: MeshConfigDocument,
    previous: MeshConfigDocument | undefined,
  ) => readonly ConfigAction[];
  readonly reconcile: (
    action: ConfigAction,
    doc: MeshConfigDocument,
  ) => Effect.Effect<void, MeshConfigError>;
}
export class MeshConfigPlanners extends Context.Service<
  MeshConfigPlanners,
  readonly ConfigPlanner[]
>()("t3/mesh/MeshConfig/MeshConfigPlanners") {}
export class MeshConfig extends Context.Service<
  MeshConfig,
  {
    readonly current: Effect.Effect<MeshConfigRevision | undefined>;
    readonly changes: Stream.Stream<MeshConfigRevision | undefined>;
    readonly plan: (
      doc: unknown,
    ) => Effect.Effect<
      { doc: MeshConfigDocument; actions: readonly ConfigAction[] },
      MeshConfigError
    >;
    readonly apply: (
      doc: unknown,
      baseRevision: string | null,
    ) => Effect.Effect<MeshConfigRevision, MeshConfigError>;
    readonly rollback: (revision: string) => Effect.Effect<MeshConfigRevision, MeshConfigError>;
    readonly history: Effect.Effect<readonly MeshConfigRevision[]>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    readonly statusChanges: Stream.Stream<
      readonly (ConfigAction & { state: "done" | "in_progress" | "failed"; reason?: string })[]
    >;
    readonly status: Effect.Effect<
      readonly (ConfigAction & { state: "done" | "in_progress" | "failed"; reason?: string })[]
    >;
  }
>()("t3/mesh/MeshConfig") {}
const encodeRevision = Schema.encodeEffect(MeshConfigRevision);
const decodeRevision = Schema.decodeUnknownOption(MeshConfigRevision);
const revisionAt = (document: MeshLayoutDocument, key: string) => {
  const decoded = decodeRevision(document[key]?.v);
  return decoded._tag === "Some" ? decoded.value : undefined;
};
export const layer = Layer.effect(
  MeshConfig,
  Effect.gen(function* () {
    const mesh = yield* MeshLayoutService;
    const planners = yield* MeshConfigPlanners;
    const lock = yield* Semaphore.make(1);
    const started = yield* Ref.make(false);
    const statuses = yield* SubscriptionRef.make<
      readonly (ConfigAction & { state: "done" | "in_progress" | "failed"; reason?: string })[]
    >([]);
    const current = mesh.read.pipe(
      Effect.map(({ document }) => revisionAt(document, "mesh.config")),
    );
    const history = mesh.read.pipe(
      Effect.map(({ document }) =>
        Object.keys(document)
          .filter((key) => key.startsWith("mesh.configHistory/"))
          .flatMap((key) => {
            const r = revisionAt(document, key);
            return r ? [r] : [];
          })
          .sort((a, b) => b.revision.localeCompare(a.revision)),
      ),
    );
    const plan = Effect.fn("MeshConfig.plan")(function* (input: unknown) {
      const doc = yield* Effect.try({
        try: () => parseConfig(input),
        catch: (cause) => new MeshConfigError({ reason: "validation", message: String(cause) }),
      });
      const errors = referenceErrors(doc);
      if (errors.length)
        return yield* new MeshConfigError({
          reason: "validation",
          message: errors.map((e) => `${e.path}: ${e.message}`).join("\n"),
        });
      const previous = yield* current;
      return { doc, actions: planners.flatMap((planner) => planner.plan(doc, previous?.doc)) };
    });
    const apply = Effect.fn("MeshConfig.apply")(function* (
      input: unknown,
      baseRevision: string | null,
    ) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const planned = yield* plan(input);
          const before = yield* current;
          if ((before?.revision ?? null) !== baseRevision)
            return yield* new MeshConfigError({
              reason: "stale_revision",
              message: "Config changed; rebase on current revision",
              ...(before ? { current: before } : {}),
              diff: [{ path: "$", before: before?.doc ?? null, after: planned.doc }],
            });
          const h = yield* mesh.nextHlc.pipe(
            Effect.mapError(
              () =>
                new MeshConfigError({
                  reason: "storage",
                  message: "Cannot allocate config revision",
                }),
            ),
          );
          const revision: MeshConfigRevision = {
            revision: h,
            doc: planned.doc,
            author: mesh.environmentId,
            writtenAt: DateTime.formatIso(yield* DateTime.now),
          };
          const value = (yield* encodeRevision(revision).pipe(Effect.orDie)) as Json;
          const entries: MeshLayoutDocument = {
            "mesh.config": { v: value, h },
            [`mesh.configHistory/${encodeURIComponent(h)}`]: { v: value, h },
          };
          const retained = [revision, ...(yield* history)];
          for (const old of retained.slice(50))
            entries[`mesh.configHistory/${encodeURIComponent(old.revision)}`] = { v: null, h };
          yield* mesh
            .apply(entries)
            .pipe(
              Effect.mapError(
                () =>
                  new MeshConfigError({ reason: "storage", message: "Cannot persist mesh config" }),
              ),
            );
          return revision;
        }),
      );
    });
    const rollback = Effect.fn("MeshConfig.rollback")(function* (revision: string) {
      const old = (yield* history).find((item) => item.revision === revision);
      if (!old)
        return yield* new MeshConfigError({
          reason: "not_found",
          message: "Config revision not found",
        });
      return yield* apply(old.doc, (yield* current)?.revision ?? null);
    });
    const changes = mesh.changes.pipe(
      Stream.map(({ document }) => revisionAt(document, "mesh.config")),
      Stream.changesWith((a, b) => a?.revision === b?.revision),
    );
    const start = Effect.gen(function* () {
      if (yield* Ref.getAndSet(started, true)) return;
      yield* changes.pipe(
        Stream.runForEach((revision) =>
          Effect.gen(function* () {
            if (!revision) return;
            const actions = planners.flatMap((planner) =>
              planner.plan(revision.doc, undefined).map((action) => ({ planner, action })),
            );
            yield* SubscriptionRef.set(
              statuses,
              actions.map(({ action }) => ({ ...action, state: "in_progress" as const })),
            );
            yield* Effect.forEach(
              actions,
              ({ planner, action }, index) =>
                planner.reconcile(action, revision.doc).pipe(
                  Effect.timeout("60 seconds"),
                  Effect.matchEffect({
                    onSuccess: () =>
                      SubscriptionRef.update(statuses, (items) =>
                        items.map((item, i) =>
                          i === index ? { ...item, state: "done" as const } : item,
                        ),
                      ),
                    onFailure: (error) =>
                      SubscriptionRef.update(statuses, (items) =>
                        items.map((item, i) =>
                          i === index
                            ? { ...item, state: "failed" as const, reason: error.message }
                            : item,
                        ),
                      ),
                  }),
                ),
              { concurrency: 4, discard: true },
            );
          }),
        ),
        Effect.forkScoped,
      );
    });
    return MeshConfig.of({
      current,
      changes,
      plan,
      apply,
      rollback,
      history,
      start,
      status: SubscriptionRef.get(statuses),
      statusChanges: SubscriptionRef.changes(statuses),
    });
  }),
);
