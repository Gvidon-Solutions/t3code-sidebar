import { ReplicaError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ReplicaRuntime from "../replicas/ReplicaRuntime.ts";
import { RunSync } from "./RunPreparation.ts";

import type { ProjectReplicaService } from "../replicas/ProjectReplicaService.ts";
const hasRunApi = (
  service: ProjectReplicaService["Service"],
): service is ProjectReplicaService["Service"] & RunSync["Service"] =>
  "flush" in service &&
  typeof service.flush === "function" &&
  "conflicts" in service &&
  typeof service.conflicts === "function" &&
  "problems" in service &&
  typeof service.problems === "function";
const get = ReplicaRuntime.getService.pipe(
  Effect.filterOrFail(
    hasRunApi,
    () =>
      new ReplicaError({
        reason: "disabled",
        message: "The replica driver lacks the run synchronization API; update this server.",
      }),
  ),
);
export const layer = Layer.effect(
  RunSync,
  Effect.gen(function* () {
    const service = yield* get;
    return RunSync.of({
      flush: Effect.fn("RunSync.flush")(function* (replica) {
        return yield* service.flush(replica);
      }),
      conflicts: Effect.fn("RunSync.conflicts")(function* (replica) {
        return yield* service.conflicts(replica);
      }),
      problems: Effect.fn("RunSync.problems")(function* (replica) {
        return yield* service.problems(replica);
      }),
    });
  }),
);
