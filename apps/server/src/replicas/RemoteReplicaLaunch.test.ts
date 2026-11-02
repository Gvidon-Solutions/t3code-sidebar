import { it, expect } from "@effect/vitest";
import { EnvironmentId, ProjectId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";
import * as Replicas from "./ProjectReplicaService.ts";
import * as Runtime from "./ReplicaRuntime.ts";
import { resolveLaunchProject } from "./RemoteReplicaLaunch.ts";
import { makeReplicaHarness } from "./replicas.testkit.ts";

it.effect(
  "a remote launch places a missing replica and resolves only after watching and project registration; waits are cancellable",
  () =>
    Effect.gen(function* () {
      const h = makeReplicaHarness("source", true);
      const runtime = Layer.effect(
        Runtime.ReplicaRuntime,
        Effect.map(Replicas.ProjectReplicaService, (replicas) => ({
          get: Effect.succeed(replicas),
        })),
      ).pipe(Layer.provideMerge(h.layer));
      yield* Effect.gen(function* () {
        const mesh = yield* MeshLayoutService;
        yield* mesh.edit((config) => ({
          ...config,
          machines: {
            ...config.machines,
            box: { label: "Box" },
            cancelled: { label: "Cancelled" },
            denied: { label: "Denied" },
          },
        }));
        const denied = Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Placement requires full access.",
          }),
        );
        expect(
          (yield* resolveLaunchProject(
            ProjectId.make("primary"),
            EnvironmentId.make("denied"),
            denied,
          ).pipe(Effect.flip))._tag,
        ).toBe("OrchestratorMcpFailure");
        expect(
          (yield* mesh.read).config.projectMounts.repo!.some(
            (rep) => rep.environmentId === "denied",
          ),
        ).toBe(false);
        let launched = false;
        const launch = yield* resolveLaunchProject(
          ProjectId.make("primary"),
          EnvironmentId.make("box"),
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              launched = true;
            }),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* mesh.changes.pipe(
          Stream.filter((snapshot) =>
            Boolean(snapshot.config.projectMounts.repo?.some((rep) => rep.environmentId === "box")),
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        expect(launched).toBe(false);
        yield* mesh.edit((config) => ({
          ...config,
          projectMounts: {
            ...config.projectMounts,
            repo: config.projectMounts.repo!.map((rep) =>
              rep.environmentId === "box"
                ? { ...rep, projectId: "remote-project", pathAllocated: true }
                : rep,
            ),
          },
          projectMountStatus: { repo: { box: { state: "watching", updatedAt: "" } } },
        }));
        expect(yield* Fiber.join(launch)).toBe("remote-project");
        expect(launched).toBe(true);
        expect(
          yield* resolveLaunchProject(ProjectId.make("primary"), EnvironmentId.make("box"), denied),
        ).toBe("remote-project");
        const cancelled = yield* Deferred.make<void>();
        const waiting = yield* resolveLaunchProject(
          ProjectId.make("primary"),
          EnvironmentId.make("cancelled"),
        ).pipe(
          Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* mesh.changes.pipe(
          Stream.filter((snapshot) =>
            Boolean(
              snapshot.config.projectMounts.repo?.some((rep) => rep.environmentId === "cancelled"),
            ),
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* Fiber.interrupt(waiting);
        yield* Deferred.await(cancelled);
        expect(
          (yield* mesh.read).config.projectMounts.repo!.find(
            (rep) => rep.environmentId === "cancelled",
          )?.projectId,
        ).toBeUndefined();
        expect(
          yield* resolveLaunchProject(ProjectId.make("already-remote"), EnvironmentId.make("box")),
        ).toBe("already-remote");
      }).pipe(Effect.provide(runtime));
    }),
);
