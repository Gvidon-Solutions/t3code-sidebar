import { MeshLayoutService } from "./MeshLayoutService.ts";
import { relayHopsAllowed, PEER_HOPS_ERROR } from "../peer/connection/peerIdentity.ts";
import { forwardedCallLimits } from "./MeshLinkPermissions.ts";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type PeerConnectionStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as PeerTransport from "../peer/connection/PeerTransport.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient, type PeerCallLimits } from "../peer/PeerMcpClient.ts";

export const RelayInput = Schema.Struct({
  environmentId: EnvironmentId,
  tool: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});
export const Routes = Schema.Array(Schema.String);
export class MeshRelay extends Context.Service<
  MeshRelay,
  {
    readonly routes: Effect.Effect<readonly string[], OrchestratorMcpFailure>;
    readonly status: Effect.Effect<readonly PeerConnectionStatus[]>;
    readonly relay: (
      input: typeof RelayInput.Type,
      hops: readonly string[],
      limits: PeerCallLimits,
    ) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  }
>()("t3/mesh/MeshRelay") {}
const refused = new OrchestratorMcpFailure({
  code: "capability_denied",
  message: PEER_HOPS_ERROR,
});
export const layer = Layer.effect(
  MeshRelay,
  Effect.gen(function* () {
    const links = yield* PeerLinks;
    const mesh = yield* MeshLayoutService;
    const transport = yield* PeerTransport.PeerTransport;
    const status = Effect.suspend(() => transport.get()?.status ?? Effect.succeed([]));
    const peers = yield* PeerMcpClient;
    const self = yield* (yield* ServerEnvironment).getEnvironmentId;
    const routes = links.list.pipe(
      Effect.map((items) =>
        items.filter((p) => p.status !== "expired").map((p) => p.environmentId),
      ),
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
      ),
    );
    const relay = Effect.fn("MeshRelay.relay")(function* (
      input: typeof RelayInput.Type,
      hops: readonly string[],
      limits: PeerCallLimits,
    ) {
      if (
        !relayHopsAllowed(hops, self, input.environmentId) ||
        (input.tool.startsWith("t3_mesh_") &&
          !["t3_mesh_update_vote", "t3_mesh_update_health"].includes(input.tool))
      )
        return yield* refused;
      const narrowed = yield* forwardedCallLimits(input.tool, limits, input.environmentId).pipe(
        Effect.provideService(MeshLayoutService, mesh),
      );
      const target = yield* links.get(input.environmentId).pipe(Effect.mapError(() => refused));
      if (Option.isNone(target)) return yield* refused;
      return yield* peers.call({
        ...input,
        limits: narrowed,
        hops: [...hops, self],
        success: Schema.Unknown,
      });
    });
    return MeshRelay.of({ routes, relay, status });
  }),
);
