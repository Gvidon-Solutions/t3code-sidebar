import {
  ProjectId,
  ReplicaError,
  type EnvironmentId,
  type OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProjectService from "../project/ProjectService.ts";
import * as Runtime from "./ReplicaRuntime.ts";

export const resolveLaunchProject = Effect.fn("RemoteReplicaLaunch.resolveLaunchProject")(
  function* (
    projectId: ProjectId,
    environmentId: EnvironmentId,
    authorizePlacement: Effect.Effect<void, OrchestratorMcpFailure> = Effect.void,
  ) {
    const runtime = yield* Runtime.ReplicaRuntime;
    const projects = yield* ProjectService.ProjectService;

    const local = yield* projects.getById(projectId).pipe(
      Effect.mapError(
        (cause) =>
          new ReplicaError({
            reason: "storage",
            message: "Could not read launch project.",
            cause,
          }),
      ),
    );
    // A caller can already be naming a project id belonging to the destination server.
    if (Option.isNone(local) || local.value.id !== projectId) return projectId;
    const replicas = yield* runtime.get;
    const known = yield* replicas.machines(projectId);
    const existing = known.representations.find((rep) => rep.environmentId === environmentId);
    if (existing?.projectId) return ProjectId.make(existing.projectId);
    yield* authorizePlacement;
    const placed = yield* replicas.place({ project: projectId, machine: environmentId, wait: 600 });
    if (!placed.ready || !placed.representation?.projectId)
      return yield* new ReplicaError({
        reason: "mutagen",
        message: "Replica did not become ready within ten minutes.",
      });
    return ProjectId.make(placed.representation.projectId);
  },
);
