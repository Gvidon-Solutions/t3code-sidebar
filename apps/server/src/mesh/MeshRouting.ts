import { type EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";

import type { PeerLinks } from "../peer/PeerLinks.ts";
import type { PeerCallLimits, PeerMcpClient } from "../peer/PeerMcpClient.ts";
import { Routes } from "./MeshRelay.ts";

const unavailable = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

/**
 * T3 Mesh (fork): calls `tool` in `environmentId` directly when this environment links to it,
 * otherwise through a full-access linked peer that does (one relay hop, `t3_mesh_relay`).
 * Every path that acts on another machine for a person or an agent goes through here.
 */
export const callRouted = Effect.fn("MeshRouting.callRouted")(function* <
  S extends Schema.Decoder<unknown>,
>(
  services: {
    readonly links: PeerLinks["Service"];
    readonly peers: PeerMcpClient["Service"];
    readonly self: string;
  },
  input: {
    readonly environmentId: EnvironmentId;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
    readonly limits: PeerCallLimits;
    readonly success: S;
  },
) {
  const { links, peers } = services;
  if (
    "connectionAvailable" in peers &&
    (yield* peers.connectionAvailable?.(input.environmentId) ?? Effect.succeed(false))
  )
    return yield* peers.call(input);
  const direct = yield* links.get(input.environmentId).pipe(Effect.mapError(unavailable));
  if (Option.isSome(direct)) return yield* peers.call(input);
  for (const peer of yield* links.list.pipe(Effect.mapError(unavailable))) {
    if (peer.access !== "full-access" || peer.status === "expired") continue;
    const routes = yield* peers
      .call({
        environmentId: peer.environmentId,
        tool: "t3_mesh_routes",
        arguments: {},
        limits: input.limits,
        success: Routes,
      })
      .pipe(
        Effect.tapError((error) => Effect.logDebug("Mesh route discovery failed", error)),
        Effect.option,
      );
    if (Option.isSome(routes) && routes.value.includes(input.environmentId)) {
      return yield* peers.call({
        environmentId: peer.environmentId,
        tool: "t3_mesh_relay",
        arguments: {
          environmentId: input.environmentId,
          tool: input.tool,
          arguments: input.arguments,
        },
        hops: [services.self],
        limits: input.limits,
        success: input.success,
      });
    }
  }
  // No route: the direct call reports the link error the caller would get without the mesh.
  return yield* peers.call(input);
});
