import {
  MeshConfigDocument,
  MeshConfigError,
  MeshConfigRevision,
  MeshConfigStatus,
  MeshConfigAction,
  MeshConfigServerStatus,
} from "@t3tools/contracts";
import {
  bindingsFromLayout,
  configDiff,
  parseConfig,
  referenceErrors,
} from "@t3tools/shared/meshConfig";
import type { Json, MeshLayoutDocument } from "@t3tools/shared/meshLayout";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Scope from "effect/Scope";
import { MeshLayoutService } from "./MeshLayoutService.ts";

export type ConfigAction = MeshConfigAction;
export interface ConfigPlanner {
  readonly name: string;
  readonly plan: (
    doc: MeshConfigDocument,
    previous: MeshConfigDocument | undefined,
  ) => Effect.Effect<readonly ConfigAction[], MeshConfigError, MeshLayoutService>;
  readonly reconcile: (
    action: ConfigAction,
    doc: MeshConfigDocument,
  ) => Effect.Effect<void, MeshConfigError, MeshLayoutService>;
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
    readonly status: Effect.Effect<MeshConfigStatus>;
  }
>()("t3/mesh/MeshConfig") {}
export type MeshConfigService = MeshConfig["Service"];
const startEffect: Effect.Effect<void, never, MeshConfig | Scope.Scope> = Effect.gen(function* () {
  const config = (yield* MeshConfig) as MeshConfigService;
  yield* config.start;
});
export const startedLayer = Layer.effectDiscard(startEffect);
const decodeStatus = Schema.decodeUnknownOption(MeshConfigServerStatus);
const encodeStatus = Schema.encodeEffect(MeshConfigServerStatus);
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
    const activeRevision = yield* Ref.make<string | null>(null);
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
      return {
        doc,
        actions: (yield* Effect.forEach(planners, (planner) =>
          planner.plan(doc, previous?.doc).pipe(Effect.provideService(MeshLayoutService, mesh)),
        )).flat(),
      };
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
              diff: configDiff(before?.doc ?? {}, planned.doc),
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
    const publishStatus = Effect.fn("MeshConfig.publishStatus")(function* (revision: string) {
      const actions = yield* SubscriptionRef.get(statuses);
      const value = (yield* encodeStatus({
        environmentId: mesh.environmentId,
        revision,
        actions,
      }).pipe(Effect.orDie)) as Json;
      const h = yield* mesh.nextHlc;
      yield* mesh.apply({
        [`mesh.configStatus/${encodeURIComponent(mesh.environmentId)}`]: { v: value, h },
      });
    });
    const changes = mesh.changes.pipe(
      Stream.map(({ document }) => revisionAt(document, "mesh.config")),
      Stream.changesWith((a, b) => a?.revision === b?.revision),
    );
    const inputs = mesh.changes.pipe(
      Stream.map((snapshot) => ({
        snapshot,
        signature: JSON.stringify({
          config: snapshot.document["mesh.config"]?.v,
          projects: snapshot.config.projectTitles,
          representations: snapshot.config.projectMounts,
          bindings: bindingsFromLayout(snapshot.document),
          history: Object.entries(snapshot.document)
            .filter(([key, entry]) => key.startsWith("mesh.configHistory/") && entry.v !== null)
            .map(([key]) => key)
            .sort(),
          machines: snapshot.config.machines,
        }),
      })),
      Stream.changesWith((a, b) => a.signature === b.signature),
      Stream.map(({ snapshot }) => revisionAt(snapshot.document, "mesh.config")),
    );
    const retries = Stream.fromSchedule(Schedule.spaced("30 seconds")).pipe(
      Stream.filterEffect(() =>
        SubscriptionRef.get(statuses).pipe(
          Effect.map((items) => items.some((item) => item.state === "failed")),
        ),
      ),
      Stream.mapEffect(() => current),
    );
    const start = Effect.gen(function* () {
      if (yield* Ref.getAndSet(started, true)) return;
      yield* Stream.merge(inputs, retries).pipe(
        Stream.runForEach((revision) =>
          Effect.gen(function* () {
            if (!revision) return;
            yield* Ref.set(activeRevision, revision.revision);
            const errors = referenceErrors(revision.doc);
            if (errors.length)
              return yield* new MeshConfigError({
                reason: "validation",
                message: errors.map((e) => `${e.path}: ${e.message}`).join("; "),
              });
            const bound = bindingsFromLayout((yield* mesh.read).document);
            const actions = (yield* Effect.forEach(planners, (planner) =>
              planner.plan(revision.doc, undefined).pipe(
                Effect.provideService(MeshLayoutService, mesh),
                Effect.map((actions) => actions.map((action) => ({ planner, action }))),
              ),
            ))
              .flat()
              .filter(
                ({ action }) =>
                  action.server === "*" ||
                  action.server === mesh.environmentId ||
                  bound[action.server] === mesh.environmentId,
              );
            yield* SubscriptionRef.set(
              statuses,
              actions.map(({ action }) => ({ ...action, state: "in_progress" as const })),
            );
            yield* publishStatus(revision.revision).pipe(
              Effect.catch((error) => Effect.logError("Config status persistence failed", error)),
            );
            yield* Effect.forEach(
              actions,
              ({ planner, action }, index) =>
                planner.reconcile(action, revision.doc).pipe(
                  Effect.provideService(MeshLayoutService, mesh),
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
            yield* publishStatus(revision.revision).pipe(
              Effect.catch((error) => Effect.logError("Config status persistence failed", error)),
            );
            const expired = (yield* history).slice(50);
            if (expired.length) {
              const h = yield* mesh.nextHlc;
              yield* mesh.apply(
                Object.fromEntries(
                  expired.map((old) => [
                    `mesh.configHistory/${encodeURIComponent(old.revision)}`,
                    { v: null, h },
                  ]),
                ),
              );
            }
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* SubscriptionRef.set(statuses, [
                  {
                    id: "config/reconcile",
                    server: mesh.environmentId,
                    description: "Reconcile config",
                    state: "failed",
                    reason: error.message,
                  },
                ]);
                if (revision)
                  yield* publishStatus(revision.revision).pipe(
                    Effect.catch((storage) =>
                      Effect.logError("Config status persistence failed", storage),
                    ),
                  );
              }),
            ),
          ),
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
      status: Effect.gen(function* () {
        const desired = yield* current;
        const { document } = yield* mesh.read;
        const localRevision = yield* Ref.get(activeRevision);
        const local = {
          environmentId: mesh.environmentId,
          revision: localRevision,
          actions: yield* SubscriptionRef.get(statuses),
        };
        const remote = Object.entries(document)
          .filter(([key]) => key.startsWith("mesh.configStatus/"))
          .flatMap(([, entry]) => {
            const value = decodeStatus(entry.v);
            return value._tag === "Some" && value.value.environmentId !== mesh.environmentId
              ? [value.value]
              : [];
          });
        const bound = bindingsFromLayout(document);
        const expected = Object.entries(bound)
          .filter(([name]) => desired?.doc.machines[name])
          .map(([, environmentId]) => environmentId);
        const environments = [
          ...new Set([
            mesh.environmentId,
            ...expected,
            ...remote.map((server) => server.environmentId),
          ]),
        ];
        const planned = desired
          ? (yield* Effect.forEach(planners, (planner) =>
              planner
                .plan(desired.doc, undefined)
                .pipe(Effect.provideService(MeshLayoutService, mesh)),
            )).flat()
          : [];
        return {
          servers: environments.map((environmentId) => {
            const report =
              environmentId === mesh.environmentId
                ? local
                : remote.find((server) => server.environmentId === environmentId);
            if (report && report.revision === desired?.revision) return report;
            return {
              environmentId,
              revision: report?.revision ?? null,
              actions: planned
                .filter(
                  (action) =>
                    action.server === environmentId ||
                    bound[action.server] === environmentId ||
                    action.server === "*",
                )
                .map((action) => ({
                  ...action,
                  state: "in_progress" as const,
                  reason: "Waiting for this server to reconcile the current revision",
                })),
            };
          }),
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            servers: [
              {
                environmentId: mesh.environmentId,
                revision: null,
                actions: [
                  {
                    id: "config/status",
                    server: mesh.environmentId,
                    description: "Read config status",
                    state: "failed" as const,
                    reason: error.message,
                  },
                ],
              },
            ],
          }),
        ),
      ),
      statusChanges: SubscriptionRef.changes(statuses),
    });
  }),
);
