import { EnvironmentId, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Schema from "effect/Schema";
import { Routes } from "./MeshRelay.ts";
import { callRouted } from "./MeshRouting.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import { assertNotLinked } from "../mcp/linkOrigin.ts";
import { readCaller } from "../mcp/threadAccess.ts";

export const discoverThreadMachines = Effect.fn("MeshThreadAccess.discover")(function* () {
  const caller = yield* readCaller();
  const { scope, limits } = caller;
  if (scope.linkedEnvironments === false || scope.client?.linked) return [];
  yield* assertNotLinked(caller, "use this environment’s links");
  const links = yield* PeerLinks;
  const peers = yield* PeerMcpClient;

  const direct = yield* links.list.pipe(
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
        : peers
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
  const caller = yield* readCaller();
  const { scope, limits } = caller;
  yield* assertNotLinked(caller, "use this environment’s links");
  const linkOption = yield* PeerLinks;
  const peerOption = yield* PeerMcpClient;

  const links = linkOption;
  const peers = peerOption;
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
