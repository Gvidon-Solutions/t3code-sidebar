import { MESH_WS_METHODS } from "@t3tools/contracts";
import type { ReplicaRefInput, ReplicaAdoptInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Runtime from "./ReplicaRuntime.ts";

export const handlers = {
  [MESH_WS_METHODS.replicasUnmanaged]: () =>
    Runtime.getService.pipe(Effect.flatMap((replicas) => replicas.unmanaged)),
  [MESH_WS_METHODS.replicasAdopt]: (input: ReplicaAdoptInput) =>
    Runtime.getService.pipe(Effect.flatMap((replicas) => replicas.adopt(input))),
  [MESH_WS_METHODS.replicasStatus]: () =>
    Stream.unwrap(Runtime.getService.pipe(Effect.map((replicas) => replicas.changes))),
  [MESH_WS_METHODS.replicasRetry]: (input: ReplicaRefInput) =>
    Runtime.getService.pipe(Effect.flatMap((replicas) => replicas.retry(input))),
};
