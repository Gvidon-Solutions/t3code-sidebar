import { MeshRollout } from "../src/mesh/MeshRollout.ts";
import { MeshBootstrap } from "../src/mesh/MeshBootstrap.ts";
import { SecretRequests } from "../src/secrets/SecretRequests.ts";
import { ThreadMoveService } from "../src/mesh/ThreadMoveService.ts";
import { ThreadForkService } from "../src/mesh/ThreadForkService.ts";
import { MeshRelay } from "../src/mesh/MeshRelay.ts";
import { MeshReplicator } from "../src/mesh/MeshReplicator.ts";
import { McpClientAuthenticator } from "../src/mcp/McpHttpServer.ts";
import { PeerForwarding } from "../src/peer/PeerForwarding.ts";
import * as PeerReceipts from "../src/peer/connection/PeerReceipts.ts";
import { ReplicaRuntime } from "../src/replicas/ReplicaRuntime.ts";
import { ProjectReplicaService } from "../src/replicas/ProjectReplicaService.ts";
import { EnvironmentId, IsoDateTime, OrchestratorMcpFailure } from "@t3tools/contracts";

import { PeerLinks } from "../src/peer/PeerLinks.ts";
import { PeerMcpClient } from "../src/peer/PeerMcpClient.ts";
import * as Directory from "../src/mesh/MeshProjectDirectory.ts";
import { ProjectService } from "../src/project/ProjectService.ts";
import { PeerCredentials } from "../src/peer/connection/PeerCredentials.ts";
import { ServerEnvironment } from "../src/environment/ServerEnvironment.ts";
import * as ApplicationEvents from "../src/persistence/OrchestrationEventStore.ts";
import * as Effect from "effect/Effect";
import * as MeshConfigTest from "../src/mesh/MeshConfigTestLayer.ts";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../src/persistence/Sqlite.ts";
import * as DeliveryAdmission from "../src/mesh/DeliveryAdmission.ts";
import * as PeerTransport from "../src/peer/connection/PeerTransport.ts";

const layout = MeshConfigTest.layerTest();
export const platform = Layer.mergeAll(layout, PeerTransport.layer);
export const layerMemory = Layer.mergeAll(DeliveryAdmission.layer, PeerTransport.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

export const services = Layer.mergeAll(layerMemory, platform);

export const runPromise = <A, E>(
  effect: import("effect/Effect").Effect<
    A,
    E,
    | import("../src/mesh/DeliveryAdmission.ts").DeliveryAdmission
    | import("../src/mesh/MeshLayoutService.ts").MeshLayoutService
    | import("../src/mesh/MeshConfig.ts").MeshConfig
    | import("../src/peer/connection/PeerTransport.ts").PeerTransport
    | import("effect/sql/SqlClient").SqlClient
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(services)));

const peers = Layer.mergeAll(
  Layer.mock(PeerLinks)({
    enabled: Effect.succeed(false),
    list: Effect.succeed([]),
    ids: Effect.succeed([]),
    get: () => Effect.succeedNone,
  }),
  Layer.succeed(PeerMcpClient, {
    call: Effect.fn("fixture.peerCall")(() =>
      Effect.fail(
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "No peer is connected in this fixture.",
        }),
      ),
    ),
  }),
  Directory.layer,
  Layer.mock(ProjectService)({
    snapshot: Effect.succeed({
      projects: [],
      updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
    }),
    getById: () => Effect.succeedNone,
  }),
  Layer.mock(PeerCredentials)({ revoke: () => Effect.void }),
  Layer.succeed(ServerEnvironment, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("studio")),
    getDescriptor: Effect.succeed({
      environmentId: EnvironmentId.make("studio"),
      label: "Studio",
      platform: { os: "linux" as const, arch: "x64" as const },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true, mcpModeLimitHeader: true, linkFence: true },
    }),
  }),
);
const replicas = Layer.mock(ProjectReplicaService)({
  start: Effect.void,
  status: Effect.succeed([]),
  machines: (project) => Effect.succeed({ logicalKey: project, representations: [] }),
});
const runtime = Layer.effect(
  ReplicaRuntime,
  Effect.map(ProjectReplicaService, (replicas) => ({ get: Effect.succeed(replicas) })),
).pipe(Layer.provide(replicas));
export const required = Layer.mergeAll(
  services,
  peers,
  runtime,
  Layer.mock(MeshRollout)({ trial: false }),
  Layer.mock(MeshBootstrap)({}),
  Layer.mock(SecretRequests)({}),
  Layer.mock(ThreadMoveService)({}),
  Layer.mock(ThreadForkService)({}),
  Layer.mock(MeshRelay)({}),
  Layer.mock(MeshReplicator)({}),
  Layer.succeed(McpClientAuthenticator, {
    authenticate: Effect.fn("fixture.authenticate")(() => Effect.sync(() => undefined)),
  }),
  Layer.mock(PeerForwarding)({}),
  PeerReceipts.layer.pipe(Layer.provide(layerMemory)),
  ApplicationEvents.layer.pipe(Layer.provide(layerMemory)),
);
