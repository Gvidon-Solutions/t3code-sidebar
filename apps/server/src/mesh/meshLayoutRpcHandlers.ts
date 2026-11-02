import { MeshLayoutError, ReplicaError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * T3 Mesh (fork) RPC seam. Stage C replaces this with `MeshLayoutService` and the replicator;
 * until then a server without the mesh reports `disabled` instead of a missing handler.
 */
const disabled = () =>
  new MeshLayoutError({
    reason: "disabled",
    message: "The T3 Mesh is not enabled on this server.",
  });

export const meshLayoutRpcHandlers = {
  "meshLayout.get": () => Effect.fail(disabled()),
  "meshLayout.apply": () => Effect.fail(disabled()),
  "meshLayout.subscribe": () => Stream.fail(disabled()),
  "replicas.status": () =>
    Stream.fail(
      new ReplicaError({ reason: "disabled", message: "Replicas are not enabled on this server." }),
    ),
  "replicas.retry": () =>
    Effect.fail(
      new ReplicaError({ reason: "disabled", message: "Replicas are not enabled on this server." }),
    ),
} as const;
