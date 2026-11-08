import * as ReplicaEnvironment from "./ReplicaEnvironment.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ReplicaPaths from "./ReplicaPaths.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  SidebarWorkspacesConfig,
  type Project,
  type ReplicaError,
  type SidebarProjectMount,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ReplicaService from "./ProjectReplicaService.ts";
import * as Runner from "./MutagenRunner.ts";
import * as MeshTest from "./MeshLayoutTestLayer.ts";

const decodeConfig = Schema.decodeSync(SidebarWorkspacesConfig);

export const makeReplicaHarness = (
  self = "replica",
  sourceDrives = false,
  onList: Effect.Effect<void, ReplicaError> = Effect.void,
  onRegister: Effect.Effect<void, ProjectService.ProjectServiceError> = Effect.void,
  onCreate: Effect.Effect<void, ReplicaError> = Effect.void,
  onListExisting: Effect.Effect<void, ReplicaError> = Effect.void,
  onConflictMtime: (root: string, paths: readonly string[]) => number = () => 0,
) => {
  const replica: SidebarProjectMount = {
    environmentId: "replica",
    path: "/replica",
    pathAllocated: true,
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
          projectId: "primary",
          role: "primary",
          transport: "git",
          createdAt: "",
        },
        replica,
      ],
    },
    machines: sourceDrives ? { source: {} } : { replica: {} },
  });
  let sessions: ReadonlyArray<Runner.MutagenSession> = [];
  const foreign: { sessions: readonly Runner.MutagenSession[] } = { sessions: [] };
  const foreignActions: string[] = [];
  const created: Runner.CreateSession[] = [];
  const preserved: Parameters<Runner.MutagenRunner["Service"]["preserveConflicts"]>[0][] = [];
  const terminated: string[] = [];
  const validation = {
    pending: [] as readonly string[],
    beforePause: Effect.void as Effect.Effect<void, ReplicaError>,
    preserve: Effect.void as Effect.Effect<void, ReplicaError>,
    check: (
      _input: Parameters<Runner.MutagenRunner["Service"]["assertReplicaPath"]>[0],
    ): Effect.Effect<void, ReplicaError> => Effect.void,
  };
  let project: Project | undefined;
  let registrations = 0;
  const runner = Layer.succeed(
    Runner.MutagenRunner,
    Runner.MutagenRunner.of({
      foreignList: Effect.sync(() => foreign.sessions),
      foreignAction: (action, identifier) =>
        Effect.sync(() => {
          foreignActions.push(`${action}:${identifier}`);
          foreign.sessions =
            action === "terminate"
              ? foreign.sessions.filter((session) => session.identifier !== identifier)
              : foreign.sessions.map((session) =>
                  session.identifier === identifier ? { ...session, paused: true } : session,
                );
        }),
      changedPaths: () => Effect.sync(() => validation.pending),
      assertReplicaPath: (input) => validation.check(input),
      preserveConflicts: (input) =>
        Effect.sync(() => {
          preserved.push(input);
        }).pipe(Effect.andThen(validation.preserve)),
      conflictMtime: (input) => Effect.sync(() => onConflictMtime(input.root, input.paths)),
      list: (selector = "t3-logical") =>
        Effect.sync(() =>
          sessions.filter((session) => session.labels?.[selector] !== undefined),
        ).pipe(Effect.tap(() => onList)),
      listExisting: Effect.sync(() => sessions).pipe(Effect.tap(() => onListExisting)),
      create: (input) =>
        onCreate.pipe(
          Effect.andThen(
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
                  ignore: { paths: input.ignores },
                  alpha: { path: input.alpha.replace(/^[^/:]+:(?=\/)/, "") },
                  beta: { path: input.beta.replace(/^[^/:]+:(?=\/)/, "") },
                },
              ];
            }),
          ),
        ),
      terminate: (name) =>
        Effect.sync(() => {
          terminated.push(name);
          sessions = sessions.filter((s) => s.name !== name && s.identifier !== name);
        }),
      pause: () =>
        validation.beforePause.pipe(
          Effect.andThen(
            Effect.sync(() => {
              sessions = sessions.map((session) => ({ ...session, paused: true }));
            }),
          ),
        ),
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
    snapshot: Effect.succeed({
      projects: [
        {
          id: ProjectId.make("primary"),
          title: "Example",
          workspaceRoot: "/source",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          deletedAt: null,
        },
      ],
      updatedAt: "2026-01-01T00:00:00Z",
    }),
    getById: (id) =>
      Effect.succeed(
        id === "primary"
          ? Option.some({
              id: ProjectId.make("primary"),
              title: "Example",
              workspaceRoot: "/source",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              deletedAt: null,
            })
          : Option.none(),
      ),
    getByWorkspaceRoot: () => Effect.sync(() => Option.fromUndefinedOr(project)),
    create: (input) =>
      onRegister.pipe(
        Effect.andThen(
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
        ),
      ),
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(HostProcess.HomeDirectory, "/tmp/t3-e-unused-test-home"),
    MeshTest.layerTest(self, initial, {
      "mesh.machineBinding/source": { v: "source", h: "0000000000000-000000-fixture" },
      "mesh.machineBinding/replica": { v: "replica", h: "0000000000000-000000-fixture" },
    }),
    ReplicaPaths.layer,
    runner,
    projects,
  ).pipe(
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const layer = ReplicaService.layer.pipe(
    Layer.provideMerge(
      ReplicaEnvironment.layer.pipe(
        Layer.provide(ProcessRunner.layer),
        Layer.provide(dependencies),
      ),
    ),
    Layer.provideMerge(dependencies),
  );
  return {
    layer,
    created,
    foreign,
    foreignActions,
    preserved,
    terminated,
    validation,
    registrations: () => registrations,
    setSession: (patch: Partial<Runner.MutagenSession>) => {
      sessions = sessions.map((s) => ({ ...s, ...patch }));
    },
    addDuplicate: () => {
      const session = sessions[0];
      if (!session) throw new Error("Create a session before duplicating it");
      sessions = [...sessions, { ...session, identifier: "duplicate-session" }];
    },
    addOrphan: (named = true) => {
      sessions = [
        ...sessions,
        {
          identifier: named ? "orphan" : "nameless",
          ...(named ? { name: "orphan" } : {}),
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
