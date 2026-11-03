import { EnvironmentId, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Routes } from "./MeshRelay.ts";
import { callRouted } from "./MeshRouting.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import { readCaller } from "../mcp/threadAccess.ts";

export const discoverThreadMachines = Effect.fn("MeshThreadAccess.discover")(function* () {
  const { scope, limits } = yield* readCaller();
  if (scope.linkedEnvironments === false || scope.client?.linked) return [];
  const links = yield* Effect.serviceOption(PeerLinks);
  const peers = yield* Effect.serviceOption(PeerMcpClient);
  if (Option.isNone(links) || Option.isNone(peers)) return [];
  const direct = yield* links.value.list.pipe(
    Effect.mapError(
      (error) =>
        new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
    ),
  );
  const routes = yield* Effect.forEach(
    direct,
    (peer) =>
      peer.access !== "full-access"
        ? Effect.succeed([] as readonly string[])
        : peers.value
            .call({
              environmentId: peer.environmentId,
              tool: "t3_mesh_routes",
              arguments: {},
              limits,
              success: Routes,
            })
            .pipe(
              Effect.timeout("5 seconds"),
              Effect.catch((error) =>
                Effect.logDebug("Mesh discovery failed", error).pipe(
                  Effect.as([] as readonly string[]),
                ),
              ),
            ),
    { concurrency: 4 },
  );
  return [...new Set([...direct.map((peer) => peer.environmentId), ...routes.flat()])]
    .filter((id) => id !== scope.environmentId)
    .map((id) => EnvironmentId.make(id));
});

export const probeThread = Effect.fn("MeshThreadAccess.probe")(function* (
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  const { scope, limits } = yield* readCaller();
  const linkOption = yield* Effect.serviceOption(PeerLinks);
  const peerOption = yield* Effect.serviceOption(PeerMcpClient);
  if (Option.isNone(linkOption) || Option.isNone(peerOption))
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "No mesh connection available.",
    });
  const links = linkOption.value;
  const peers = peerOption.value;
  return yield* callRouted(
    { links, peers, self: scope.environmentId },
    {
      environmentId,
      tool: "t3_thread_read",
      arguments: { threadId, limit: 1 },
      limits,
      success: Schema.Struct({ thread: Schema.Struct({ threadId: ThreadId }) }),
    },
  );
});
