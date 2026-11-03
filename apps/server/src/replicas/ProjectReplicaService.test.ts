import * as FileSystem from "effect/FileSystem";
import * as Runner from "./MutagenRunner.ts";
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
          state: "mounting",
          conflicts: [],
          message: "Resolved 1 conflicts automatically · copies in .t3-conflicts",
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
        yield* service.reconcile;
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

it.effect(
  "preserves the authority-selected loser on either driver and persists the calm resolution note",
  () =>
    Effect.gen(function* () {
      for (const sourceDrives of [false, true]) {
        for (const authority of ["source", "replica", "elsewhere"]) {
          const self = sourceDrives ? "source" : "replica";
          const h = harness(self, sourceDrives);
          yield* Effect.gen(function* () {
            const service = yield* ReplicaService.ProjectReplicaService;
            const mesh = yield* MeshLayoutService;
            yield* mesh.edit((c) => ({ ...c, meshAuthority: authority }));
            yield* service.reconcile;
            expect(h.created[0]?.ignores).toContain(".t3-conflicts");
            h.setSession({ status: "watching", conflicts: [{ root: "file" }] });
            yield* service.reconcile;
            const loser = authority === "replica" ? "source" : "replica";
            expect(h.preserved).toHaveLength(1);
            expect(h.preserved[0]).toMatchObject({
              root: `/${loser}`,
              paths: ["file"],
              environmentId: loser,
            });
            expect(Boolean(h.preserved[0]?.route)).toBe(loser !== self);
            expect((yield* mesh.read).config.projectMountStatus.repo?.replica).toMatchObject({
              state: "mounting",
              message: "Resolved 1 conflicts automatically · copies in .t3-conflicts",
              conflictCopies: { environmentId: loser },
            });
            h.setSession({ conflicts: [], status: "watching" });
            yield* service.reconcile;
            yield* service.reconcile;
            expect((yield* service.status)[0]?.message).toContain("Resolved 1");
            expect(h.created).toHaveLength(1);
          }).pipe(Effect.provide(h.layer));
        }
      }
    }),
);

it.effect(
  "terminates a removed representation after a driver restart using its durable tombstone, keeping orphan sessions",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* ReplicaService.ProjectReplicaService;
      const runner = yield* Runner.MutagenRunner;
      const mesh = yield* MeshLayoutService;
      yield* runner.create({
        ...sessionIdentity("repo", "replica"),
        alpha: "source:/source",
        beta: "/replica",
        ignores: [".t3-conflicts"],
      });
      h.addOrphan();
      yield* mesh.edit((config) => ({ ...config, projectMounts: {} }));
      yield* service.reconcile;
      expect(h.terminated).toEqual([sessionIdentity("repo", "replica").name]);
      expect((yield* service.status).some((row) => row.sessionName === "orphan")).toBe(true);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("workspaces do not alter a replica's endpoints, driver or session identity", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* ReplicaService.ProjectReplicaService;
    const mesh = yield* MeshLayoutService;
    yield* service.reconcile;
    const original = h.created[0];
    yield* mesh.edit((c) => ({
      ...c,
      workspaces: [{ id: "quiet", name: "Quiet" }],
      defaultWorkspace: "quiet",
      assignments: { repo: "quiet" },
      placements: { repo: ["quiet"] },
      workspaceProjectOrder: { quiet: ["repo"] },
      workspaceFold: { quiet: { repo: "quiet" } },
      rules: [{ match: "*", workspace: "quiet" }],
    }));
    const document = (yield* mesh.read).document;
    yield* service.reconcile;
    expect(h.created).toEqual([original]);
    expect(h.terminated).toEqual([]);
    expect((yield* mesh.read).document).toEqual(document);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "recreates a legacy conflict session with the mandatory copies ignore before propagating",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* ReplicaService.ProjectReplicaService;
      yield* service.reconcile;
      h.setSession({ ignore: { paths: [] }, conflicts: [{ root: "file" }] });
      yield* service.reconcile;
      expect(h.preserved).toHaveLength(1);
      expect(h.terminated).toEqual([h.created[0]!.name]);
      expect(h.created).toHaveLength(2);
      expect(h.created[1]).toEqual(h.created[0]);
      expect(h.created[1]?.ignores).toContain(".t3-conflicts");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("rejects a replica as another replica's primary source", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* ReplicaService.ProjectReplicaService;
    const mesh = yield* MeshLayoutService;
    yield* mesh.edit((c) => ({
      ...c,
      projectMounts: {
        repo: c.projectMounts.repo!.map((rep) =>
          rep.environmentId === "source" ? { ...rep, role: "replica" } : rep,
        ),
      },
    }));
    yield* service.reconcile;
    expect(h.created).toEqual([]);
    expect((yield* service.status)[0]).toMatchObject({
      state: "error",
      message: "Replica source representation is missing.",
    });
  }).pipe(Effect.provide(h.layer));
});

it.effect("adopts one managed session and removes an accidental duplicate by identifier", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* ReplicaService.ProjectReplicaService;
    yield* service.reconcile;
    h.addDuplicate();
    yield* service.reconcile;
    expect(h.terminated).toEqual(["duplicate-session"]);
    yield* service.reconcile;
    expect(h.created).toHaveLength(1);
    expect(h.terminated).toEqual(["duplicate-session"]);
  }).pipe(Effect.provide(h.layer));
});

it.effect("retains an explicit replacement path rather than allocating another folder", () => {
  const h = harness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "N-explicit-" });
    const service = yield* ReplicaService.ProjectReplicaService;
    const placed = yield* service.place({
      project: "repo",
      machine: "replica",
      path: `${root}/requested/nested`,
    });
    expect(placed.representation?.path).toBe(`${root}/requested/nested`);
    expect(yield* fs.exists(`${root}/requested/nested`)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(h.layer));
});

it.effect(
  "records manual transport and per-copy ignores without starting a managed sync session",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "N-manual-" });
      const service = yield* ReplicaService.ProjectReplicaService;
      const placed = yield* service.place({
        project: "repo",
        machine: "replica",
        path: root,
        transport: "manual",
        ignores: ["*.tmp", "cache"],
      });
      expect(placed.representation).toMatchObject({
        path: root,
        transport: "manual",
        ignores: ["*.tmp", "cache"],
      });
      yield* service.reconcile;
      expect(h.created).toEqual([]);
      expect(h.registrations()).toBe(1);
      expect((yield* service.status)[0]).toMatchObject({
        state: "watching",
        message: "Manual copy",
      });
    }).pipe(Effect.scoped, Effect.provide(h.layer));
  },
);

it.effect(
  "adopts a foreign session, pauses before creating, preserves conflicts and terminates only after watching",
  () => {
    const h = harness("source", true);
    h.foreign.sessions = [
      {
        identifier: "manual-id",
        name: "N-manual",
        paused: false,
        status: "watching",
        alpha: { protocol: "local", path: "/source" },
        beta: { protocol: "ssh", host: "replica", path: "/replica" },
        ignore: { paths: ["*.cache"] },
      },
    ];
    return Effect.gen(function* () {
      let service = yield* ReplicaService.ProjectReplicaService;
      expect(yield* service.unmanaged).toHaveLength(1);
      expect(
        (yield* service.adopt({ project: "repo", session: "N-manual" })).representation?.path,
      ).toBe("/replica");
      expect(h.foreignActions).toEqual([]);
      yield* service.reconcile;
      expect(h.foreignActions).toEqual(["pause:manual-id"]);
      expect(h.created).toHaveLength(1);
      expect(h.created[0]?.ignores).toContain("*.cache");
      expect(h.created[0]?.ignores).toContain(".t3-conflicts");
      service = yield* ReplicaService.ProjectReplicaService.pipe(
        Effect.provide(ReplicaService.layer),
      );
      h.setSession({ conflicts: [{ root: "both.txt" }], status: "watching" });
      yield* service.reconcile;
      expect(h.preserved).toMatchObject([{ root: "/replica", paths: ["both.txt"] }]);
      expect(h.foreignActions).toEqual(["pause:manual-id"]);
      h.setSession({ conflicts: [], status: "watching" });
      yield* service.reconcile;
      expect(h.foreignActions).toEqual(["pause:manual-id"]);
      service = yield* ReplicaService.ProjectReplicaService.pipe(
        Effect.provide(ReplicaService.layer),
      );
      yield* service.reconcile;
      expect(h.foreignActions).toEqual(["pause:manual-id", "terminate:manual-id"]);
      expect(
        (yield* (yield* MeshLayoutService).read).config.projectMounts.repo?.find(
          (rep) => rep.environmentId === "replica",
        )?.adoption,
      ).toBeUndefined();
      expect(h.created).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "keeps one existing session while a legacy logical id migrates and removes it after a restarted-driver tombstone",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* ReplicaService.ProjectReplicaService;
      const mesh = yield* MeshLayoutService;
      yield* service.reconcile;
      h.setSession({ status: "watching" });
      yield* mesh.edit((current) => {
        const { repo, ...rest } = current.projectMounts;
        return {
          ...current,
          projectAliases: { repo: "opaque" },
          projectMounts: {
            ...rest,
            opaque: (repo ?? []).map((rep) => ({ ...rep, syncKey: "repo" })),
          },
        };
      });
      yield* service.reconcile;
      expect(h.created).toHaveLength(1);
      expect(h.terminated).toEqual([]);
      expect((yield* service.status).find((status) => status.logicalKey === "opaque")?.state).toBe(
        "watching",
      );
      yield* mesh.edit((current) => ({
        ...current,
        projectMounts: {
          ...current.projectMounts,
          opaque: current.projectMounts.opaque!.filter((rep) => rep.environmentId !== "replica"),
        },
      }));
      const restarted = yield* ReplicaService.ProjectReplicaService.pipe(
        Effect.provide(ReplicaService.layer),
      );
      yield* restarted.reconcile;
      expect(h.terminated).toEqual([h.created[0]!.name]);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("after restart terminates the session of a path claim suppressed by authority", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* ReplicaService.ProjectReplicaService;
    const mesh = yield* MeshLayoutService;
    yield* service.reconcile;
    const rep = (yield* mesh.read).config.projectMounts.repo!.find(
      (rep) => rep.environmentId === "replica",
    )!;
    yield* mesh.apply({
      "mesh.authority": { v: "owner", h: "0000000000001.00000.owner" },
      "rep/winner/replica": {
        v: { ...rep, role: "primary", transport: "git" },
        h: "0000000000001.00000.owner",
      },
    });
    const restarted = yield* ReplicaService.ProjectReplicaService.pipe(
      Effect.provide(ReplicaService.layer),
    );
    yield* restarted.reconcile;
    expect(h.terminated).toEqual([h.created[0]!.name]);
    expect(h.created).toHaveLength(1);
    expect(
      (yield* mesh.read).config.projectMounts.repo?.some((rep) => rep.environmentId === "replica"),
    ).toBe(false);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a corrected placement clears a stale failure and waits for the new configuration to watch",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* ReplicaService.ProjectReplicaService;
      const mesh = yield* MeshLayoutService;
      yield* service.reconcile;
      h.setSession({ status: "watching" });
      yield* service.reconcile;
      yield* mesh.edit((current) => ({
        ...current,
        projectMountStatus: {
          ...current.projectMountStatus,
          repo: { replica: { state: "error", message: "Previous folder differs", updatedAt: "" } },
        },
      }));
      const corrected = yield* service.place({
        project: "repo",
        machine: "replica",
        ignores: ["*.cache"],
      });
      expect(corrected.ready).toBe(false);
      expect((yield* mesh.read).config.projectMountStatus.repo?.replica).toMatchObject({
        state: "pending",
      });
      yield* service.reconcile;
      h.setSession({ status: "watching" });
      yield* service.reconcile;
      expect(yield* service.waitForProject("repo", "replica", 30)).toBeDefined();
      const changed = yield* service.place({
        project: "repo",
        machine: "replica",
        ignores: ["*.other"],
      });
      expect(changed.ready).toBe(false);
      expect((yield* mesh.read).config.projectMountStatus.repo?.replica?.state).toBe("pending");
      yield* service.reconcile;
      h.setSession({ status: "watching" });
      yield* service.reconcile;
      yield* service.place({ project: "repo", machine: "replica", ignores: ["cache", "!cache"] });
      yield* service.reconcile;
      h.setSession({ status: "watching" });
      yield* service.reconcile;
      const beforeReorder = h.created.length;
      yield* service.place({ project: "repo", machine: "replica", ignores: ["!cache", "cache"] });
      yield* service.reconcile;
      expect(h.created).toHaveLength(beforeReorder + 1);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect.each(["failure", "success"] as const)(
  "discards an in-flight folder %s after the requested path changes",
  (outcome) => {
    const h = harness();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "N-stale-placement-" });
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      h.validation.check = (input) =>
        input.destination.path === `${root}/rejected`
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.andThen(
                outcome === "failure"
                  ? Effect.fail(
                      new ReplicaError({ reason: "storage", message: "Previous folder differs" }),
                    )
                  : Effect.void,
              ),
            )
          : Effect.void;
      const service = yield* ReplicaService.ProjectReplicaService;
      const mesh = yield* MeshLayoutService;
      yield* mesh.edit((current) => ({
        ...current,
        projectMounts: {
          ...current.projectMounts,
          repo: current.projectMounts.repo!.map((rep) =>
            rep.environmentId === "replica"
              ? { ...rep, path: `${root}/rejected`, explicitPath: true, pathValidated: false }
              : rep,
          ),
        },
      }));
      const old = yield* service.reconcile.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* service.place({ project: "repo", machine: "replica", path: `${root}/corrected` });
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(old);
      expect((yield* mesh.read).config.projectMountStatus.repo?.replica?.state).toBe("pending");
      expect(h.created).toHaveLength(0);
      expect(
        (yield* service.status).some((status) => status.message === "Previous folder differs"),
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(h.layer));
  },
);

it.effect("keeps an unmounted legacy project's id when its local record is first placed", () => {
  const h = harness("source", true);
  return Effect.gen(function* () {
    const service = yield* ReplicaService.ProjectReplicaService;
    const mesh = yield* MeshLayoutService;
    yield* mesh.edit((current) => ({
      ...current,
      projectMounts: {},
      machines: { ...current.machines, replica: { label: "Replica" } },
      projectAliases: { "title:example": "canonical" },
      projectTitles: { canonical: "Shared renamed title" },
    }));
    const placed = yield* service.place({ project: "primary", machine: "replica" });
    expect(placed.logicalKey).toBe("canonical");
    expect((yield* mesh.read).config.projectTitles.canonical).toBe("Shared renamed title");
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "registers a watching copy with skipped scan paths, persists warnings and clears them on recovery",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* ReplicaService.ProjectReplicaService;
      const mesh = yield* MeshLayoutService;
      yield* service.reconcile;
      h.setSession({
        status: "watching",
        alpha: {
          path: "/source",
          scanProblems: [
            { path: "outside", error: "absolute symlink" },
            { path: "private", error: "permission denied" },
          ],
        },
      });
      yield* service.reconcile;
      expect(h.registrations()).toBe(1);
      expect((yield* mesh.read).config.projectMountStatus.repo?.replica).toMatchObject({
        state: "watching",
        skipped: 2,
        skippedPaths: [{ path: "outside" }, { path: "private" }],
        message: expect.stringContaining("2 files skipped"),
      });
      expect((yield* service.status)[0]).toMatchObject({ state: "watching", skipped: 2 });
      h.setSession({ alpha: { path: "/source" } });
      yield* service.reconcile;
      expect((yield* mesh.read).config.projectMountStatus.repo?.replica?.skipped).toBeUndefined();
      h.setSession({ lastError: "Source disconnected", conflicts: [{ root: "file" }] });
      yield* service.reconcile;
      expect((yield* mesh.read).config.projectMountStatus.repo?.replica).toMatchObject({
        state: "error",
        message: "Source disconnected",
      });
      expect(h.preserved).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "recreates a session whose ignore configuration is absent instead of keeping old ignores",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* ReplicaService.ProjectReplicaService;
      yield* service.reconcile;
      h.setSession({ status: "watching", ignore: {} });
      yield* service.place({ project: "repo", machine: "replica", ignores: ["new-ignore"] });
      yield* service.reconcile;
      expect(h.created).toHaveLength(2);
      expect(h.created[1]?.ignores).toContain("new-ignore");
      expect(h.terminated).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "a shared daemon inspection failure never fabricates an error on every healthy copy",
  () => {
    let failed = false;
    const h = harness(
      "source",
      true,
      Effect.void,
      Effect.void,
      Effect.void,
      Effect.suspend(() =>
        failed
          ? Effect.fail(new ReplicaError({ reason: "mutagen", message: "Cannot inspect daemon" }))
          : Effect.void,
      ),
    );
    return Effect.gen(function* () {
      const service = yield* ReplicaService.ProjectReplicaService;
      const mesh = yield* MeshLayoutService;
      yield* mesh.edit((c) => ({
        ...c,
        machines: {
          ...c.machines,
          source: { reach: { replica: { ssh: "replica" }, other: { ssh: "other" } } },
        },
        projectMounts: {
          ...c.projectMounts,
          repo: [
            ...c.projectMounts.repo!,
            {
              ...c.projectMounts.repo!.find((rep) => rep.role === "replica")!,
              environmentId: "other",
              path: "/other",
            },
          ],
        },
      }));
      yield* service.reconcile;
      h.setSession({ status: "watching" });
      yield* service.reconcile;
      expect(
        Object.values((yield* mesh.read).config.projectMountStatus.repo!).map((s) => s.state),
      ).toEqual(["watching", "watching"]);
      failed = true;
      expect(yield* service.reconcile.pipe(Effect.isFailure)).toBe(true);
      expect(
        Object.values((yield* mesh.read).config.projectMountStatus.repo!).map((s) => s.state),
      ).toEqual(["watching", "watching"]);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("a missing foreign adoption session only blocks its own copy", () => {
  const h = harness("source", true);
  return Effect.gen(function* () {
    const service = yield* ReplicaService.ProjectReplicaService;
    const mesh = yield* MeshLayoutService;
    yield* mesh.edit((c) => {
      const copy = c.projectMounts.repo!.find((rep) => rep.role === "replica")!;
      return {
        ...c,
        machines: {
          ...c.machines,
          source: { reach: { replica: { ssh: "replica" }, other: { ssh: "other" } } },
        },
        projectMounts: {
          ...c.projectMounts,
          repo: [
            c.projectMounts.repo!.find((rep) => rep.role === "primary")!,
            {
              ...copy,
              adoption: { environmentId: "source", sessionIdentifier: "missing", paused: false },
            },
            { ...copy, environmentId: "other", path: "/other" },
          ],
        },
      };
    });
    yield* service.reconcile;
    h.setSession({ status: "watching" });
    yield* service.reconcile;
    const states = (yield* mesh.read).config.projectMountStatus.repo!;
    expect(states.replica).toMatchObject({
      state: "error",
      message: expect.stringContaining("disappeared"),
    });
    expect(states.other?.state).toBe("watching");
  }).pipe(Effect.provide(h.layer));
});
