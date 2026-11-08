import * as MeshTestServices from "../../testFixtures/meshServices.ts";
import { ProjectId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Directory from "./MeshProjectDirectory.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import { ProjectReplicaService } from "../replicas/ProjectReplicaService.ts";
import { makeReplicaHarness } from "../replicas/replicas.testkit.ts";

const project = {
  id: ProjectId.make("source-project"),
  title: "Incoming source",
  workspaceRoot: "/source/project",
  createdAt: "",
};
it.effect(
  "keeps the newest complete snapshot, including deletion, when catalogs arrive out of order",
  () =>
    Effect.gen(function* () {
      const directory = yield* Directory.MeshProjectDirectory;
      yield* directory.accept([
        { environmentId: "source", h: "0000000000002.00000.source", projects: [] },
        { environmentId: "source", h: "0000000000001.00000.source", projects: [project] },
      ]);
      expect((yield* directory.read)[0]?.projects).toEqual([]);
      yield* directory.accept([
        { environmentId: "source", h: "0000000000001.00000.source", projects: [project] },
      ]);
      expect((yield* directory.read)[0]?.projects).toEqual([]);
    }).pipe(Effect.provide(Layer.provideMerge(Directory.layer, MeshTestServices.required))),
);

it.effect(
  "resolves a name after incoming-only mesh gossip without enrolling or linking machines",
  () =>
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>();
      const directory = yield* Directory.MeshProjectDirectory;
      const h = makeReplicaHarness();
      const observed = Layer.succeed(Directory.MeshProjectDirectory, {
        ...directory,
        changes: directory.changes.pipe(Stream.tap(() => Deferred.succeed(waiting, undefined))),
      });
      yield* Effect.gen(function* () {
        const replicas = yield* ProjectReplicaService;
        const mesh = yield* MeshLayoutService;
        yield* mesh.edit((config) => ({ ...config, projectMounts: {}, projectTitles: {} }));
        const before = (yield* mesh.read).document;
        const lookup = yield* replicas.machines("Incoming source").pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        yield* directory.accept([
          { environmentId: "source", h: "0000000000003.00000.source", projects: [project] },
        ]);
        expect(yield* Fiber.join(lookup)).toMatchObject({
          title: "Incoming source",
          representations: [
            {
              environmentId: "source",
              projectId: project.id,
              path: project.workspaceRoot,
              role: "primary",
            },
          ],
        });
        const again = yield* replicas.machines(
          (yield* replicas.machines("Incoming source")).logicalKey,
        );
        expect(again.title).toBe("Incoming source");
        expect((yield* mesh.read).document).toEqual(before);
      }).pipe(Effect.provide(h.layer.pipe(Layer.provideMerge(observed))));
    }).pipe(Effect.provide(Layer.provideMerge(Directory.layer, MeshTestServices.required))),
);

it.effect("bounds a missing-name wait and reacts to layout-only metadata changes", () =>
  Effect.gen(function* () {
    let entered = yield* Deferred.make<void>();
    const directory = yield* Directory.MeshProjectDirectory;
    const h = makeReplicaHarness();
    const observed = Layer.succeed(Directory.MeshProjectDirectory, {
      ...directory,
      changes: directory.changes.pipe(Stream.tap(() => Deferred.succeed(entered, undefined))),
    });
    yield* Effect.gen(function* () {
      const replicas = yield* ProjectReplicaService;
      const mesh = yield* MeshLayoutService;
      yield* mesh.edit((config) => ({ ...config, projectMounts: {}, projectTitles: {} }));
      const missing = yield* replicas.machines("Missing").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("20 seconds");
      expect((yield* Fiber.join(missing).pipe(Effect.flip)).reason).toBe("unreachable");
      entered = yield* Deferred.make<void>();
      const waiting = yield* replicas.machines("Layout project").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* mesh.edit((config) => ({
        ...config,
        projectTitles: { logical: "Layout project" },
        projectMounts: {
          logical: [
            {
              environmentId: "source",
              path: "/source/project",
              projectId: "source-project",
              role: "primary",
              transport: "git",
              createdAt: "",
            },
          ],
        },
      }));
      expect(yield* Fiber.join(waiting)).toMatchObject({
        logicalKey: "logical",
        title: "Layout project",
      });
    }).pipe(Effect.provide(h.layer.pipe(Layer.provideMerge(observed))));
  }).pipe(Effect.provide(Layer.provideMerge(Directory.layer, MeshTestServices.required))),
);
