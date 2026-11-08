import { MeshConfigError, MeshConfigServerStatus } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { materialize, merge, tick, type MeshLayoutDocument } from "@t3tools/shared/meshLayout";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Ref from "effect/Ref";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import * as Config from "./MeshConfig.ts";

const isServerStatus = Schema.is(MeshConfigServerStatus);

const layout = Layer.effect(
  MeshLayoutService,
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make({
      document: {} as MeshLayoutDocument,
      config: DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    });
    const clock = yield* Ref.make(tick(0, null, "studio"));
    const apply = Effect.fn("TestMesh.apply")(function* (entries: MeshLayoutDocument) {
      const old = yield* SubscriptionRef.get(state);
      const document = merge(old.document, entries);
      const next = { document, config: materialize(document) };
      yield* SubscriptionRef.set(state, next);
      return next;
    });
    return MeshLayoutService.of({
      environmentId: "studio",
      read: SubscriptionRef.get(state),
      changes: SubscriptionRef.changes(state),
      nextHlc: Ref.updateAndGet(clock, (h) => tick(0, h, "studio")),
      apply,
      edit: () => SubscriptionRef.get(state),
      editLegacy: () => SubscriptionRef.get(state),
    });
  }),
);
const layer = Config.layer.pipe(
  Layer.provideMerge(layout),
  Layer.provide(
    Layer.succeed(Config.MeshConfigPlanners, [
      {
        name: "machines",
        plan: (doc) =>
          Effect.succeed(
            Object.keys(doc.machines).map((server) => ({
              id: `machine/${server}`,
              server: "studio",
              description: "Update machine display",
            })),
          ),
        reconcile: (action) =>
          action.id === "machine/cloudbox"
            ? Effect.fail(
                new MeshConfigError({ reason: "storage", message: "Replica server offline" }),
              )
            : Effect.void,
      },
    ]),
  ),
);
const oncePlanners = Layer.succeed(Config.MeshConfigPlanners, [
  {
    name: "once",
    plan: Effect.fn("test.once.plan")(function* () {
      const mesh = yield* MeshLayoutService;
      return (yield* mesh.read).document["mesh.machineBinding/studio"]?.v
        ? []
        : [{ id: "once/studio", server: "studio", description: "Bind studio" }];
    }),
    reconcile: Effect.fn("test.once.reconcile")(
      function* () {
        const mesh = yield* MeshLayoutService;
        const h = yield* mesh.nextHlc;
        yield* mesh.apply({ "mesh.machineBinding/studio": { v: "studio", h } });
      },
      Effect.mapError(
        (error) => new MeshConfigError({ reason: "storage", message: error.message }),
      ),
    ),
  },
]);
it.effect(
  "reconciles the latest revision after observed changes queue behind a running action",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const executed: string[] = [];
      const planners = Layer.succeed(Config.MeshConfigPlanners, [
        {
          name: "revision",
          plan: (doc) =>
            Effect.succeed([
              {
                id: String(doc.machines.studio?.label),
                server: "studio",
                description: "Apply latest revision",
              },
            ]),
          reconcile: Effect.fn("test.reconcileRevision")(function* (action) {
            executed.push(action.id);
            if (action.id === "first") {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            } else yield* Deferred.succeed(finished, undefined);
          }),
        },
      ]);
      yield* Effect.gen(function* () {
        const config = yield* Config.MeshConfig;
        const mesh = yield* MeshLayoutService;
        const first = yield* config.apply(
          { schema: 1, machines: { studio: { label: "first" } } },
          null,
        );
        yield* config.start;
        yield* Deferred.await(entered);
        yield* mesh.apply({
          "mesh.machineBinding/studio": { h: yield* mesh.nextHlc, v: "studio" },
        });
        yield* config.apply(
          { schema: 1, machines: { studio: { label: "latest" } } },
          first.revision,
        );
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(finished);
        expect(executed.filter((id) => id === "first")).toHaveLength(1);
        expect(executed).toContain("latest");
      }).pipe(
        Effect.provide(Config.layer.pipe(Layer.provideMerge(layout), Layer.provide(planners))),
      );
    }).pipe(Effect.scoped),
);
it.layer(Config.layer.pipe(Layer.provideMerge(layout), Layer.provide(oncePlanners)))(
  "MeshConfig completed action retention",
  (it) => {
    it.effect("retains done actions after their world changes and after a restart", () =>
      Effect.gen(function* () {
        const config = yield* Config.MeshConfig;
        const mesh = yield* MeshLayoutService;
        yield* config.apply({ schema: 1, machines: { studio: {} } }, null);
        const ready = yield* Deferred.make<void>();
        const reports = yield* config.statusChanges.pipe(
          Stream.tap(() => Deferred.succeed(ready, undefined)),
          Stream.drop(1),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        const persistedReady = yield* Deferred.make<void>();
        const firstDone = yield* mesh.changes.pipe(
          Stream.tap(() => Deferred.succeed(persistedReady, undefined)),
          Stream.filter((snapshot) => {
            const value = snapshot.document["mesh.configStatus/studio"]?.v;
            return (
              isServerStatus(value) &&
              value.actions.some((action) => action.id === "once/studio" && action.state === "done")
            );
          }),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* Deferred.await(persistedReady);
        yield* config.start;
        const completed = {
          id: "once/studio",
          server: "studio",
          description: "Bind studio",
          state: "done",
        };
        expect((yield* Fiber.join(reports)).at(-1)).toEqual([completed]);
        const done = Option.getOrThrow(yield* Fiber.join(firstDone));
        yield* TestClock.adjust("30 seconds");
        expect((yield* mesh.read).document["mesh.configStatus/studio"]).toEqual(
          done.document["mesh.configStatus/studio"],
        );
        yield* Effect.gen(function* () {
          const restarted = yield* Config.MeshConfig;
          expect(restarted).not.toBe(config);
          yield* restarted.start;
          const actions = yield* restarted.statusChanges.pipe(
            Stream.filter((items) =>
              items.some((item) => item.id === "once/studio" && item.state === "done"),
            ),
            Stream.runHead,
          );
          expect(Option.getOrThrow(actions)).toEqual([completed]);
          yield* TestClock.adjust("30 seconds");
          expect((yield* mesh.read).document["mesh.configStatus/studio"]).toEqual(
            done.document["mesh.configStatus/studio"],
          );
        }).pipe(
          Effect.provide(
            Layer.fresh(Config.layer).pipe(
              Layer.provide(Layer.succeed(MeshLayoutService, mesh)),
              Layer.provide(oncePlanners),
            ),
          ),
        );
      }),
    );
  },
);
it.effect("streams replicated config revisions and suppresses unrelated layout changes", () =>
  Effect.gen(function* () {
    const config = yield* Config.MeshConfig;
    const mesh = yield* MeshLayoutService;
    const ready = yield* Deferred.make<void>();
    const changes = yield* config.changes.pipe(
      Stream.tap(() => Deferred.succeed(ready, undefined)),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(ready);
    const h = yield* mesh.nextHlc;
    yield* mesh.apply({ "future/report": { v: "unrelated", h } });
    const revision = {
      revision: h,
      doc: { schema: 1, machines: { studio: {} } },
      author: "cloudbox",
      writtenAt: "2026-01-01T00:00:00Z",
    };
    yield* mesh.apply({ "mesh.config": { v: revision, h } });
    expect(yield* Fiber.join(changes)).toEqual([undefined, revision]);
    expect(yield* config.current).toEqual(revision);
  }).pipe(Effect.provide(layer)),
);
it.layer(layer)("MeshConfig storage", (it) => {
  it.effect("validates, plans, rejects stale edits, rolls back and retains fifty revisions", () =>
    Effect.gen(function* () {
      const config = yield* Config.MeshConfig;
      const first = yield* config.apply({ schema: 1, machines: { studio: { label: "ST" } } }, null);
      expect((yield* config.plan(first.doc)).actions).toHaveLength(1);
      const stale = yield* config
        .apply({ schema: 1, machines: { studio: { label: "S3" } } }, null)
        .pipe(Effect.flip);
      expect(stale.reason).toBe("stale_revision");
      expect(stale.current?.revision).toBe(first.revision);
      expect(stale.diff?.[0]?.path).toBe("$.machines.studio.label");
      const second = yield* config.apply(
        { schema: 1, machines: { studio: { label: "S2" } } },
        first.revision,
      );
      const restored = yield* config.rollback(first.revision);
      expect(restored.doc).toEqual(first.doc);
      expect(restored.revision).not.toBe(second.revision);
      let base = restored.revision;
      for (let i = 0; i < 50; i++)
        base = (yield* config.apply(
          { schema: 1, machines: { studio: { label: String(i) } } },
          base,
        )).revision;
      expect(yield* config.history).toHaveLength(50);
      expect((yield* config.rollback(first.revision).pipe(Effect.flip)).reason).toBe("not_found");
      expect((yield* config.plan({ schema: 3, machines: {} }).pipe(Effect.flip)).message).toContain(
        "schema",
      );
      expect(
        (yield* config
          .plan({ schema: 1, machines: { studio: { reach: { via: "missing" } } } })
          .pipe(Effect.flip)).message,
      ).toContain("machines.studio.reach.via");
    }),
  );
  it.effect("resumes reconciliation from stored config and reports failures independently", () =>
    Effect.gen(function* () {
      const config = yield* Config.MeshConfig;
      yield* config.apply(
        { schema: 1, machines: { studio: {}, cloudbox: {} } },
        (yield* config.current)?.revision ?? null,
      );
      yield* config.start;
      yield* config.start;
      const states = yield* config.statusChanges.pipe(
        Stream.filter(
          (items) => items.length === 2 && items.every((item) => item.state !== "in_progress"),
        ),
        Stream.runHead,
      );
      expect(
        (yield* config.status).servers.find((server) => server.environmentId === "studio")?.actions,
      ).toEqual([
        {
          id: "machine/studio",
          server: "studio",
          description: "Update machine display",
          state: "done",
        },
        {
          id: "machine/cloudbox",
          server: "studio",
          description: "Update machine display",
          state: "failed",
          reason: "Replica server offline",
        },
      ]);
      expect(Option.getOrThrow(states)).toHaveLength(2);
    }),
  );
});

it.effect("records startup identity repair as a revision and moves a renamed binding", () =>
  Effect.gen(function* () {
    const mesh = yield* MeshLayoutService;
    const config = yield* Config.MeshConfig;
    const initial = yield* config.apply(
      { schema: 1, machines: { studio: { title: "Studio" } } },
      null,
    );
    const h = yield* mesh.nextHlc;
    yield* mesh.apply({
      "mesh.machineBinding/studio": { v: "alpha", h },
      "mesh.machineClaim/alpha": { v: { name: "studio", machine: { title: "Studio" } }, h },
      "machine/beta": { v: { title: "Studio" }, h },
    });
    yield* config.start;
    const repaired = yield* mesh.changes.pipe(
      Stream.filter((state) => state.document["mesh.machineBinding/studio-2"]?.v === "beta"),
      Stream.take(1),
      Stream.runHead,
    );
    expect(Option.isSome(repaired)).toBe(true);
    const current = (yield* config.current)!;
    expect(current.revision).not.toBe(initial.revision);
    expect((yield* config.history).some((revision) => revision.revision === current.revision)).toBe(
      true,
    );
    const { studio, ...others } = current.doc.machines;
    yield* config.apply(
      { ...current.doc, machines: { ...others, laptop: studio } },
      current.revision,
    );
    expect((yield* mesh.read).document["mesh.machineBinding/laptop"]?.v).toBe("alpha");
    expect((yield* mesh.read).document["mesh.machineBinding/studio"]?.v).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("retains but refuses a replicated future config schema before running planners", () =>
  Effect.gen(function* () {
    const service = yield* Config.MeshConfig;
    const mesh = yield* MeshLayoutService;
    const h = yield* mesh.nextHlc;
    yield* mesh.apply({
      "mesh.config": {
        h,
        v: {
          revision: h,
          doc: { schema: 2, machines: { studio: {} }, future: { enabled: true } },
          author: "cloudbox",
          writtenAt: "",
        },
      },
    });
    yield* service.start;
    const status = yield* service.statusChanges.pipe(
      Stream.filter((actions) => actions.some((action) => action.state === "failed")),
      Stream.take(1),
      Stream.runCollect,
    );
    expect(Array.from(status)[0]).toEqual([
      expect.objectContaining({
        id: "config/reconcile",
        state: "failed",
        reason: "Unsupported schema: 2",
      }),
    ]);
    expect((yield* mesh.read).document["mesh.config"]?.v).toMatchObject({
      doc: { future: { enabled: true } },
    });
    expect(Object.keys((yield* mesh.read).document)).not.toContain("mesh.machineBinding/studio");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("rollout timing persists while forced interruption is removed on the next update", () =>
  Effect.gen(function* () {
    const config = yield* Config.MeshConfig;
    yield* config.apply(
      { schema: 1, machines: {}, t3: { future: true, drain: { newerPolicy: true } } },
      null,
    );
    yield* config.updateVersion("0.1.6", false, { now: true, maxWaitMs: 120000 });
    expect((yield* config.current)?.doc.t3).toEqual({
      version: "0.1.6",
      future: true,
      drain: { maxWaitMs: 120000, skipForVersion: "0.1.6", newerPolicy: true },
    });
    yield* config.updateVersion("0.1.6", false);
    expect((yield* config.current)?.doc.t3?.drain).toEqual({
      maxWaitMs: 120000,
      newerPolicy: true,
    });
    const preview = yield* config.updateVersion("0.1.7", true, { now: true });
    expect("doc" in preview && preview.doc.t3?.drain?.skipForVersion).toBe("0.1.7");
    expect((yield* config.current)?.doc.t3?.version).toBe("0.1.6");
  }).pipe(Effect.provide(layer)),
);
