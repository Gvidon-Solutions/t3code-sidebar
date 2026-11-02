import { ReplicaError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * T3 Mesh (fork): replica RPCs until the replica service is wired. The layout RPCs are served by
 * `MeshLayoutService` in ws.ts; never spread layout handlers here, they would shadow the real ones.
 */
const disabled = () =>
  new ReplicaError({ reason: "disabled", message: "Replicas are not enabled on this server." });

export const replicaRpcFallbackHandlers = {
  "replicas.status": () => Stream.fail(disabled()),
  "replicas.retry": () => Effect.fail(disabled()),
} as const;
