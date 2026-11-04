import { MeshConfigError } from "@t3tools/contracts";
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
import { MeshLayoutService } from "./MeshLayoutService.ts";
import * as Config from "./MeshConfig.ts";

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
        yield* config.start;
        const completed = {
          id: "once/studio",
          server: "studio",
          description: "Bind studio",
          state: "done",
        };
        expect((yield* Fiber.join(reports)).at(-1)).toEqual([completed]);
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
