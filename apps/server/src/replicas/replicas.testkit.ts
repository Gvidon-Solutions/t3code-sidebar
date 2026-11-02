import * as ReplicaPaths from "./ReplicaPaths.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
      list: () => Effect.sync(() => sessions).pipe(Effect.tap(() => onList)),
      listExisting: Effect.sync(() => sessions),
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
                  alpha: { path: input.alpha },
                  beta: { path: input.beta },
                },
              ];
            }),
          ),
        ),
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
    MeshTest.layerTest(self, initial),
    ReplicaPaths.layer,
    runner,
    projects,
  ).pipe(Layer.provideMerge(ServerSettings.layerTest()), Layer.provideMerge(NodeServices.layer));
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
