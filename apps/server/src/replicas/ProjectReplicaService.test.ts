import { ReplicaError } from "@t3tools/contracts";
import * as Runtime from "./ReplicaRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";
import * as ReplicaService from "./ProjectReplicaService.ts";
import { sessionIdentity } from "./replicaModel.ts";
import { makeReplicaHarness as harness } from "./replicas.testkit.ts";
import { ProjectOperationError } from "../project/ProjectService.ts";

it.effect(
  "ensures once under concurrent reconciliation, registers on watching, reports states and removes only the managed session",
  () =>
    Effect.gen(function* () {
      const h = harness();
      yield* Effect.gen(function* () {
        const service = yield* ReplicaService.ProjectReplicaService;
        const mesh = yield* MeshLayoutService;
        yield* Effect.all([service.reconcile, service.reconcile], { concurrency: 2 });
        expect(h.created).toHaveLength(1);
        expect(h.created[0]).toMatchObject({ alpha: "source:/source", beta: "/replica" });
        expect((yield* service.status)[0]?.state).toBe("mounting");
        h.setSession({ status: "watching" });
        yield* service.reconcile;
        expect(h.registrations()).toBe(1);
        expect(
          (yield* mesh.read).config.projectMounts.repo?.find(
            (rep) => rep.environmentId === "replica",
          )?.projectId,
        ).toBeDefined();
        const clockBefore = (yield* mesh.read).document;
        yield* service.reconcile;
        expect((yield* mesh.read).document).toEqual(clockBefore);
        h.setSession({ conflicts: [{ root: "hello" }] });
        yield* service.reconcile;
        expect((yield* service.status)[0]).toMatchObject({
          state: "conflict",
          conflicts: ["hello"],
        });
        h.setSession({ conflicts: [], paused: true });
        yield* service.reconcile;
        expect((yield* service.status)[0]?.state).toBe("paused");
        yield* service.retry({ logicalKey: "repo", environmentId: "replica" });
        expect((yield* service.status)[0]?.state).toBe("watching");
        h.setSession({ lastError: "offline" });
        yield* service.reconcile;
        expect((yield* service.status)[0]?.state).toBe("error");
        h.addOrphan();
        h.addOrphan(false);
        yield* service.reconcile;
        expect((yield* service.status).some((s) => s.sessionName === "orphan")).toBe(true);
        expect((yield* service.status).some((s) => s.sessionName === "nameless")).toBe(true);
        yield* mesh.edit((config) => ({
          ...config,
          projectMounts: {
            repo: config.projectMounts.repo!.filter((r) => r.environmentId !== "replica"),
          },
        }));
        yield* service.reconcile;
        expect(h.terminated).toEqual([sessionIdentity("repo", "replica").name]);
        expect(
          (yield* service.status).some(
            (row) => row.sessionName === sessionIdentity("repo", "replica").name,
          ),
        ).toBe(false);
        expect(h.registrations()).toBe(1);
      }).pipe(Effect.provide(h.layer));
    }),
);
it.effect(
  "the source drives when only its route exists; a replica registers after replicated watching",
  () =>
    Effect.gen(function* () {
      const h = harness("source", true);
      yield* Effect.gen(function* () {
        const service = yield* ReplicaService.ProjectReplicaService;
        yield* service.reconcile;
        expect(h.created[0]).toMatchObject({ alpha: "/source", beta: "replica:/replica" });
        h.setSession({ status: "watching" });
        yield* service.reconcile;
        expect(h.registrations()).toBe(0);
      }).pipe(Effect.provide(h.layer));
      const replica = harness(
        "replica",
        true,
        Effect.die("An observer must not install or start Mutagen."),
      );
      yield* Effect.gen(function* () {
        const service = yield* ReplicaService.ProjectReplicaService;
        const mesh = yield* MeshLayoutService;
        yield* mesh.edit((config) => ({
          ...config,
          projectMountStatus: { repo: { replica: { state: "watching", updatedAt: "" } } },
        }));
        yield* service.reconcile;
        expect(replica.created).toEqual([]);
        expect(replica.registrations()).toBe(1);
        expect((yield* service.status)[0]).toMatchObject({
          state: "watching",
          projectId: expect.any(String),
        });
        yield* mesh.edit((config) => ({ ...config, machines: {} }));
        yield* service.reconcile;
        expect((yield* service.status)[0]?.state).toBe("error");
        expect(
          yield* service
            .retry({ logicalKey: "missing", environmentId: "replica" })
            .pipe(Effect.isFailure),
        ).toBe(true);
      }).pipe(Effect.provide(replica.layer));
    }),
);
it.effect("recovers an existing labeled session without creating it after service restart", () =>
  Effect.gen(function* () {
    const h = harness();
    yield* Effect.gen(function* () {
      yield* (yield* ReplicaService.ProjectReplicaService).reconcile;
    }).pipe(Effect.provide(h.layer));
    expect(h.created).toHaveLength(1);
    h.setSession({ status: "watching" });
    yield* Effect.gen(function* () {
      const service = yield* ReplicaService.ProjectReplicaService;
      yield* service.reconcile;
      expect((yield* service.status)[0]?.state).toBe("watching");
      expect(h.created).toHaveLength(1);
      expect(h.registrations()).toBe(1);
    }).pipe(Effect.provide(Layer.fresh(h.layer)));
  }),
);

it.effect(
  "production runtime starts once, reconciles layout changes and polls every 30 seconds",
  () =>
    Effect.gen(function* () {
      const lists = yield* Ref.make(0);
      const observed = yield* Deferred.make<void>();
      const h = harness(
        "replica",
        false,
        Ref.update(lists, (n) => n + 1),
      );
      const runtime = Runtime.withRuntime(h.layer).pipe(
        Layer.provide(
          ServerConfig.layerTest("/tmp", "/tmp/t3-replica-runtime-test").pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const replicas = yield* Runtime.getService;
        expect(yield* (yield* Runtime.ReplicaRuntime).get).toBe(replicas);
        yield* replicas.changes.pipe(
          Stream.filter(({ replicas }) => replicas.some((rep) => rep.state === "mounting")),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* TestClock.adjust("0 seconds");
        expect(h.created).toHaveLength(1);
        const baseline = yield* Ref.get(lists);
        yield* replicas.start;
        yield* TestClock.adjust("29 seconds");
        expect(yield* Ref.get(lists)).toBe(baseline);
        yield* TestClock.adjust("1 second");
        expect(yield* Ref.get(lists)).toBeGreaterThan(baseline);
        h.setSession({ status: "watching" });
        const watcher = yield* replicas.changes.pipe(
          Stream.filter(({ replicas }) => replicas.some((rep) => rep.state === "watching")),
          Stream.take(1),
          Stream.runDrain,
          Effect.tap(() => Deferred.succeed(observed, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* (yield* MeshLayoutService).edit((config) => ({
          ...config,
          machines: { ...config.machines, source: { label: "Primary changed" } },
        }));
        yield* Deferred.await(observed);
        yield* Fiber.join(watcher);
        yield* (yield* MeshLayoutService).changes.pipe(
          Stream.filter((snapshot) =>
            Boolean(
              snapshot.config.projectMounts.repo?.find((rep) => rep.environmentId === "replica")
                ?.projectId,
            ),
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        expect(h.registrations()).toBe(1);
        expect(h.created).toHaveLength(1);
      }).pipe(Effect.provide(runtime));
    }),
);

it.effect(
  "places by name or id and machine tag, waits for registration, lists state and removes without deleting a project",
  () =>
    Effect.gen(function* () {
      const h = harness("source", true);
      yield* Effect.gen(function* () {
        const service = yield* ReplicaService.ProjectReplicaService;
        const mesh = yield* MeshLayoutService;
        yield* mesh.edit((config) => ({
          ...config,
          machines: { ...config.machines, newPeer: { label: "New peer", tag: "NP" } },
        }));
        const placed = yield* service.place({ project: "Example", machine: "NP" });
        expect(placed.representation).toMatchObject({
          environmentId: "newPeer",
          role: "replica",
          source: "source",
        });
        const waiting = yield* service
          .place({ project: "primary", machine: "New peer", wait: 60 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* mesh.edit((config) => ({
          ...config,
          projectMounts: {
            ...config.projectMounts,
            repo: config.projectMounts.repo!.map((rep) =>
              rep.environmentId === "newPeer"
                ? { ...rep, projectId: "remote-project", pathAllocated: true }
                : rep,
            ),
          },
          projectMountStatus: { repo: { newPeer: { state: "watching", updatedAt: "" } } },
        }));
        expect(yield* Fiber.join(waiting)).toMatchObject({
          ready: true,
          representation: { projectId: "remote-project" },
        });
        const machines = yield* service.machines("repo");
        expect(
          machines.representations.find((rep) => rep.environmentId === "newPeer"),
        ).toMatchObject({ tag: "NP", status: { state: "watching" } });
        expect(yield* service.place({ project: "repo", machine: "NP", action: "remove" })).toEqual({
          logicalKey: "repo",
          representation: null,
          ready: true,
        });
        expect(h.terminated).toEqual([]);
        expect(
          (yield* mesh.read).config.projectMounts.repo!.some(
            (rep) => rep.environmentId === "newPeer",
          ),
        ).toBe(false);
        expect(
          yield* service.place({ project: "repo", machine: "missing" }).pipe(Effect.isFailure),
        ).toBe(true);
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect(
  "a destination registers a newly declared primary without starting Mutagen synchronization",
  () =>
    Effect.gen(function* () {
      const h = harness();
      yield* Effect.gen(function* () {
        const service = yield* ReplicaService.ProjectReplicaService;
        const mesh = yield* MeshLayoutService;
        yield* mesh.edit((config) => ({
          ...config,
          projectMounts: {
            repo: config.projectMounts.repo!.map((rep) =>
              rep.environmentId === "replica"
                ? { ...rep, role: "primary" as const, transport: "git" as const }
                : rep,
            ),
          },
        }));
        yield* service.reconcile;
        expect(
          (yield* mesh.read).config.projectMounts.repo!.find(
            (rep) => rep.environmentId === "replica",
          )?.projectId,
        ).toBeDefined();
        expect(h.registrations()).toBe(1);
        expect(h.created).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect(
  "installation/list failures become persisted replica errors and recover on the next reconciliation",
  () =>
    Effect.gen(function* () {
      let unavailable = true;
      const h = harness(
        "replica",
        false,
        Effect.suspend(() =>
          unavailable
            ? Effect.fail(
                new ReplicaError({ reason: "mutagen", message: "Mutagen download failed." }),
              )
            : Effect.void,
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* ReplicaService.ProjectReplicaService;
        const mesh = yield* MeshLayoutService;
        expect((yield* service.reconcile.pipe(Effect.flip)).reason).toBe("mutagen");
        expect((yield* mesh.read).config.projectMountStatus.repo?.replica).toMatchObject({
          state: "error",
          message: "Mutagen download failed.",
        });
        expect((yield* service.status)[0]).toMatchObject({
          state: "error",
          problems: ["Mutagen download failed."],
        });
        unavailable = false;
        yield* service.reconcile;
        expect((yield* service.status)[0]?.state).toBe("mounting");
        expect(h.created).toHaveLength(1);
      }).pipe(Effect.provide(h.layer));
    }),
);

it.effect(
  "registration failures stay stable and observers preserve the driver's watching status",
  () =>
    Effect.gen(function* () {
      for (const sourceDrives of [false, true]) {
        let unavailable = true;
        const h = harness(
          "replica",
          sourceDrives,
          Effect.void,
          Effect.suspend(() =>
            unavailable
              ? Effect.fail(
                  new ProjectOperationError({
                    operation: "dispatch-project-command",
                    cause: "disk full",
                  }),
                )
              : Effect.void,
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* ReplicaService.ProjectReplicaService;
          const mesh = yield* MeshLayoutService;
          if (sourceDrives) {
            yield* mesh.edit((config) => ({
              ...config,
              projectMountStatus: { repo: { replica: { state: "watching", updatedAt: "" } } },
            }));
          } else {
            yield* service.reconcile;
            h.setSession({ status: "watching" });
          }
          yield* service.reconcile;
          expect((yield* service.status)[0]?.state).toBe("error");
          expect((yield* mesh.read).config.projectMountStatus.repo?.replica?.state).toBe(
            sourceDrives ? "watching" : "error",
          );
          const stable = (yield* mesh.read).document;
          yield* service.reconcile;
          expect((yield* mesh.read).document).toEqual(stable);
          unavailable = false;
          yield* service.reconcile;
          expect(h.registrations()).toBe(1);
          expect((yield* service.status)[0]?.state).toBe("watching");
        }).pipe(Effect.provide(h.layer));
      }
    }),
);

it.effect(
  "after restart a driver change terminates the old private session and preserves orphans",
  () =>
    Effect.gen(function* () {
      const h = harness();
      yield* Effect.gen(function* () {
        yield* (yield* ReplicaService.ProjectReplicaService).reconcile;
      }).pipe(Effect.provide(h.layer));
      h.addOrphan();
      yield* Effect.gen(function* () {
        const service = yield* ReplicaService.ProjectReplicaService;
        const mesh = yield* MeshLayoutService;
        yield* mesh.edit((config) => ({
          ...config,
          machines: { source: { reach: { replica: { ssh: "replica" } } } },
        }));
        yield* service.reconcile;
        expect(h.terminated).toEqual([sessionIdentity("repo", "replica").name]);
        expect(
          (yield* service.status).find((row) => row.sessionName === "orphan")?.message,
        ).toContain("left untouched");
        yield* service.reconcile;
        expect(h.terminated).toHaveLength(1);
      }).pipe(Effect.provide(Layer.fresh(h.layer)));
    }),
);

it.effect(
  "creation errors retry on the interval without feeding back through driver status edits",
  () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const h = harness(
        "replica",
        false,
        Effect.void,
        Effect.void,
        Ref.update(attempts, (count) => count + 1).pipe(
          Effect.andThen(
            Effect.fail(new ReplicaError({ reason: "mutagen", message: "SSH unavailable" })),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* ReplicaService.ProjectReplicaService;
        yield* service.start;
        yield* service.changes.pipe(
          Stream.filter(({ replicas }) => replicas.some((row) => row.state === "error")),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* TestClock.adjust("0 seconds");
        expect(yield* Ref.get(attempts)).toBe(1);
        yield* TestClock.adjust("30 seconds");
        expect(yield* Ref.get(attempts)).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(h.layer));
    }),
);
