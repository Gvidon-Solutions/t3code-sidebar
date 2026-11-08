import { ServerActivation } from "../serverActivation.ts";
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { DocumentText } from "../provider/DocumentText.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ReplicaRuntime } from "../replicas/ReplicaRuntime.ts";
import * as Layout from "../replicas/MeshLayoutTestLayer.ts";
import * as ForkTransactions from "./ForkTransactions.ts";
import * as Fork from "./ThreadForkService.ts";

class ForkReadError extends Schema.TaggedError<ForkReadError>()("ForkTransactionError", {
  cause: Schema.Defect(),
}) {}

it.effect("bounds expiry retries while keeping the durable staging transaction for recovery", () =>
  Effect.gen(function* () {
    const listed = yield* Deferred.make<void>();
    let attempts = 0;
    const value = { phase: "uploading" as const, forkId: "expiry-fork", expiresAt: 1000 };
    const journal = Layer.mock(ForkTransactions.ForkTransactions)({
      list: Deferred.succeed(listed, undefined).pipe(Effect.as([{ key: "expiry-fork", value }])),
      read: () =>
        Effect.gen(function* () {
          if ((yield* Clock.currentTimeMillis) >= value.expiresAt) {
            attempts++;
            return yield* new ForkReadError({ cause: new Error("Storage unavailable") });
          }
          return value;
        }),
    });
    const dependencies = Layer.mergeAll(
      Layout.layerTest("studio", DEFAULT_SIDEBAR_WORKSPACES_CONFIG),
      ServerConfig.layerTest(process.cwd(), { prefix: "F2b-fork-expiry-" }),
      Layer.mock(ServerSecretStore)({}),
      Layer.mock(DocumentText)({}),
      Layer.mock(PeerLinks)({}),
      Layer.mock(PeerMcpClient)({}),
      Layer.mock(OrchestratorV2)({}),
      Layer.mock(ProjectService)({}),
      Layer.mock(ProviderRegistry)({}),
      Layer.mock(ProjectionStoreV2)({}),
      Layer.mock(ReplicaRuntime)({}),
      journal,
    ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
    yield* Effect.gen(function* () {
      yield* Fork.ThreadForkService;
      yield* Deferred.await(listed);
      yield* TestClock.adjust("2 minutes");
      expect(attempts).toBe(7);
      yield* TestClock.adjust("1 hour");
      expect(attempts).toBe(7);
    }).pipe(
      Effect.provide(Fork.layerTest.pipe(Layer.provide(dependencies))),
      Effect.provideService(ServerActivation, Effect.void),
    );
  }).pipe(Effect.scoped),
);
