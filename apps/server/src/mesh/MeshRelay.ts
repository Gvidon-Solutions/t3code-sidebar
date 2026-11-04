import { linkPermissions } from "./MeshLinkPermissions.ts";
import { EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient, type PeerCallLimits } from "../peer/PeerMcpClient.ts";

export const RelayInput = Schema.Struct({
  environmentId: EnvironmentId,
  tool: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});
export const Routes = Schema.Array(Schema.String);
export const HOP_HEADER = "t3-mesh-hops";
export class MeshRelay extends Context.Service<
  MeshRelay,
  {
    readonly routes: Effect.Effect<readonly string[], OrchestratorMcpFailure>;
    readonly relay: (
      input: typeof RelayInput.Type,
      hops: readonly string[],
      limits: PeerCallLimits,
    ) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  }
>()("t3/mesh/MeshRelay") {}
const refused = new OrchestratorMcpFailure({
  code: "capability_denied",
  message: "Mesh relay requires a direct full-access link, at most two hops and no loops",
});
export const layer = Layer.effect(
  MeshRelay,
  Effect.gen(function* () {
    const links = yield* PeerLinks;
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
        hops.length !== 1 ||
        hops.includes(self) ||
        hops.includes(input.environmentId) ||
        input.environmentId === self ||
        input.tool.startsWith("t3_mesh_")
      )
        return yield* refused;
      const permissions = yield* linkPermissions(input.environmentId);
      const threads =
        input.tool.startsWith("t3_thread_") ||
        input.tool.startsWith("t3_attachment_") ||
        [
          "t3_queue",
          "t3_pending_request",
          "create_threads",
          "delegate_task",
          "task_status",
          "task_cancel",
        ].includes(input.tool);
      const replicas = input.tool === "t3_project_place" || input.tool === "t3_replica_adopt";
      const files = input.tool === "t3_files_read" || input.tool === "t3_files_list";
      if (
        (threads && !permissions.threads) ||
        (replicas && !permissions.replicas) ||
        (files && permissions.files === "none")
      )
        return yield* refused;
      const fileRank = { none: 0, projects: 1, all: 2 };
      const incoming = limits.files ?? "all";
      const narrowedFiles =
        fileRank[incoming] < fileRank[permissions.files] ? incoming : permissions.files;
      const target = yield* links.get(input.environmentId).pipe(Effect.mapError(() => refused));
      if (Option.isNone(target)) return yield* refused;
      return yield* peers.call({
        ...input,
        limits: {
          ...limits,
          ...(files && narrowedFiles !== "all" ? { files: narrowedFiles } : {}),
          ...(!permissions.replicas || limits.replicas === false ? { replicas: false } : {}),
        },
        hops: [...hops, self],
        success: Schema.Unknown,
      });
    });
    return MeshRelay.of({ routes, relay });
  }),
);
