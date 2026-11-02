import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import {
  SidebarWorkspacesConfig,
  type Project,
  type SidebarProjectMount,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ReplicaService from "./ProjectReplicaService.ts";
import * as Runner from "./MutagenRunner.ts";
import * as MeshTest from "./MeshLayoutTestLayer.ts";
import { sessionIdentity } from "./replicaModel.ts";

const decodeConfig = Schema.decodeSync(SidebarWorkspacesConfig);

const harness = (self = "replica", sourceDrives = false) => {
  const replica: SidebarProjectMount = {
    environmentId: "replica",
    path: "/replica",
    transport: "mutagen",
    role: "replica",
    source: "source",
    createdAt: "",
  };
  const initial = decodeConfig({
    projectMounts: {
      repo: [
        {
          environmentId: "source",
          path: "/source",
          role: "primary",
          transport: "git",
          createdAt: "",
        },
        replica,
      ],
    },
    machines: sourceDrives
      ? { source: { reach: { replica: { ssh: "replica" } } } }
      : { replica: { reach: { source: { ssh: "source" } } } },
  });
  let sessions: ReadonlyArray<Runner.MutagenSession> = [];
  const created: Runner.CreateSession[] = [];
  const terminated: string[] = [];
  let project: Project | undefined;
  let registrations = 0;
  const runner = Layer.succeed(
    Runner.MutagenRunner,
    Runner.MutagenRunner.of({
      list: () => Effect.sync(() => sessions),
      create: (input) =>
        Effect.sync(() => {
          created.push(input);
          sessions = [
            ...sessions,
            {
              identifier: input.name,
              name: input.name,
              labels: { "t3-logical": input.logicalHash, "t3-env": input.environmentTag },
              paused: false,
              status: "scanning",
              alpha: { path: input.alpha },
              beta: { path: input.beta },
            },
          ];
        }),
      terminate: (name) =>
        Effect.sync(() => {
          terminated.push(name);
          sessions = sessions.filter((s) => s.name !== name);
        }),
      pause: () => Effect.void,
      resume: () =>
        Effect.sync(() => {
          sessions = sessions.map((s) => ({ ...s, paused: false }));
        }),
      reset: () => Effect.void,
      flush: () => Effect.void,
      daemon: () => Effect.void,
    }),
  );
  const projects = Layer.mock(ProjectService.ProjectService)({
    getByWorkspaceRoot: () => Effect.sync(() => Option.fromUndefinedOr(project)),
    create: (input) =>
      Effect.sync(() => {
        registrations++;
        project = {
          id: input.projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          deletedAt: null,
        };
        return project;
      }),
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(HostProcess.HomeDirectory, "/tmp/t3-e-unused-test-home"),
    MeshTest.layerTest(self, initial),
    runner,
    projects,
    ServerSettings.layerTest(),
    NodeServices.layer,
  );
  const layer = ReplicaService.layer.pipe(Layer.provideMerge(dependencies));
  return {
    layer,
    created,
    terminated,
    registrations: () => registrations,
    setSession: (patch: Partial<Runner.MutagenSession>) => {
      sessions = sessions.map((s) => ({ ...s, ...patch }));
    },
    addOrphan: () => {
      sessions = [
        ...sessions,
        {
          identifier: "orphan",
          name: "orphan",
          labels: { "t3-logical": "orphan" },
          paused: false,
          status: "watching",
          alpha: { path: "/a" },
          beta: { path: "/b" },
        },
      ];
    },
  };
};
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
        yield* service.reconcile;
        expect((yield* service.status).some((s) => s.sessionName === "orphan")).toBe(true);
        yield* mesh.edit((config) => ({
          ...config,
          projectMounts: {
            repo: config.projectMounts.repo!.filter((r) => r.environmentId !== "replica"),
          },
        }));
        yield* service.reconcile;
        expect(h.terminated).toEqual([sessionIdentity("repo", "replica").name]);
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
      const replica = harness("replica", true);
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
