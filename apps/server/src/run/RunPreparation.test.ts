import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { ReplicaError, SidebarWorkspacesConfig } from "@t3tools/contracts";
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";
import * as Preparation from "./RunPreparation.ts";

const decodeConfig = Schema.decodeSync(SidebarWorkspacesConfig);

const setup = (
  options: {
    readonly conflicts?: readonly string[];
    readonly problems?: readonly string[];
    readonly flush?: Effect.Effect<boolean, ReplicaError>;
  } = {},
) => {
  const operations: string[] = [];
  const config = decodeConfig({
    projectMounts: {
      app: [
        {
          environmentId: "laptop",
          path: "/copy",
          role: "replica",
          transport: "mutagen",
          source: "cloud",
          createdAt: "",
        },
        { environmentId: "cloud", path: "/work", role: "primary", transport: "git", createdAt: "" },
      ],
    },
  });
  const mesh = Layer.mock(MeshLayoutService)({
    environmentId: "laptop",
    read: Effect.succeed({
      config,
      document: {
        "mesh.machineBinding/cloudbox": { v: "cloud", h: "0000000000001.00000.laptop" },
      },
    }),
  });
  const sync = Layer.succeed(Preparation.RunSync, {
    flush: () =>
      Effect.sync(() => operations.push("flush")).pipe(
        Effect.andThen(options.flush ?? Effect.succeed(true)),
      ),
    conflicts: () =>
      Effect.sync(() => {
        operations.push("conflicts");
        return options.conflicts ?? [];
      }),
    problems: () =>
      Effect.sync(() => {
        operations.push("problems");
        return options.problems ?? [];
      }),
  });
  return { operations, layer: Preparation.layer.pipe(Layer.provide(Layer.merge(mesh, sync))) };
};
it.effect(
  "flushes before inspecting conflicts and problems and flushes again after completion",
  () => {
    const h = setup();
    return Effect.gen(function* () {
      const service = yield* Preparation.RunPreparation;
      const plan = yield* service.prepare("/copy/src", "10 seconds");
      expect(h.operations).toEqual(["flush", "conflicts", "problems"]);
      yield* service.finish(plan, "10 seconds");
      expect(h.operations).toEqual(["flush", "conflicts", "problems", "flush"]);
      expect(yield* service.prepare("/elsewhere", "10 seconds")).toEqual({ kind: "local" });
      expect(h.operations).toHaveLength(4);
    }).pipe(Effect.provide(h.layer));
  },
);
it.effect("refuses with all distinct file problems and exit 75", () => {
  const h = setup({ conflicts: ["src/a", "src/b"], problems: ["src/a", "src/c: unreadable"] });
  return Effect.gen(function* () {
    const service = yield* Preparation.RunPreparation;
    const result = yield* service.prepare("/copy", "10 seconds").pipe(Effect.flip);
    expect(result.paths).toEqual(["src/a", "src/b", "src/c: unreadable"]);
    expect(result.exitCode).toBe(75);
    expect(result.message).toContain("src/c: unreadable");
  }).pipe(Effect.provide(h.layer));
});
it.effect("does not inspect stale state after a failed or unowned flush", () =>
  Effect.gen(function* () {
    for (const flush of [
      Effect.succeed(false),
      Effect.fail(new ReplicaError({ reason: "mutagen", message: "offline" })),
    ]) {
      const h = setup({ flush });
      yield* Effect.gen(function* () {
        const service = yield* Preparation.RunPreparation;
        expect((yield* service.prepare("/copy", "10 seconds").pipe(Effect.flip)).exitCode).toBe(75);
        expect(h.operations).toEqual(["flush"]);
      }).pipe(Effect.provide(h.layer));
    }
  }),
);
it.effect("bounds a stuck flush without serializing another run behind it", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const h = setup({
      flush: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.gen(function* () {
      const service = yield* Preparation.RunPreparation;
      const pending = yield* service
        .prepare("/copy", "2 seconds")
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      expect(yield* service.prepare("/outside", "2 seconds")).toEqual({ kind: "local" });
      yield* TestClock.adjust("2 seconds");
      const error = yield* Fiber.join(pending);
      expect(error.reason).toBe("timeout");
      expect(error.exitCode).toBe(75);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.effect("allows two remote preparations to flush concurrently", () =>
  Effect.gen(function* () {
    const arrivals = yield* Queue.unbounded<void>();
    const release = yield* Deferred.make<boolean>();
    const h = setup({
      flush: Queue.offer(arrivals, undefined).pipe(Effect.andThen(Deferred.await(release))),
    });
    yield* Effect.gen(function* () {
      const service = yield* Preparation.RunPreparation;
      const first = yield* service.prepare("/copy/one", "10 seconds").pipe(Effect.forkChild);
      const second = yield* service.prepare("/copy/two", "10 seconds").pipe(Effect.forkChild);
      yield* Queue.take(arrivals);
      yield* Queue.take(arrivals);
      yield* Deferred.succeed(release, true);
      expect(yield* Fiber.join(first)).toMatchObject({ cwd: "/work/one" });
      expect(yield* Fiber.join(second)).toMatchObject({ cwd: "/work/two" });
    }).pipe(Effect.provide(h.layer));
  }),
);
