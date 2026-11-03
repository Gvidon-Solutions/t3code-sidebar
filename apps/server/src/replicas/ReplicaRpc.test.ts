import * as RpcGroup from "effect/rpc/RpcGroup";
import { it, expect } from "@effect/vitest";
import {
  MeshRpcs,
  WsReplicasStatusRpc,
  WsReplicasRetryRpc,
  RpcScopeAuthorization,
  AuthOrchestrationOperateScope,
  MESH_WS_METHODS,
  clientRpcRequiredScopes,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as Runtime from "./ReplicaRuntime.ts";
import * as Replicas from "./ProjectReplicaService.ts";
import * as Rpc from "./ReplicaRpc.ts";
import { makeReplicaHarness } from "./replicas.testkit.ts";

const group = RpcGroup.make(
  WsReplicasStatusRpc,
  WsReplicasRetryRpc,
  MeshRpcs[6],
  MeshRpcs[7],
).middleware(RpcScopeAuthorization);
it.effect(
  "real replica RPC handlers stream status, retry, and require project operation permission on both endpoints",
  () =>
    Effect.gen(function* () {
      const h = makeReplicaHarness();
      yield* Effect.gen(function* () {
        const replicas = yield* Replicas.ProjectReplicaService;
        yield* replicas.reconcile;
        const runtime = Layer.succeed(Runtime.ReplicaRuntime, { get: Effect.succeed(replicas) });
        const handlers = group.toLayer(Rpc.handlers).pipe(Layer.provide(runtime));
        const denied = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([]))),
        );
        expect(
          yield* denied[MESH_WS_METHODS.replicasRetry]({
            logicalKey: "repo",
            environmentId: "replica",
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
        expect(
          yield* denied[MESH_WS_METHODS.replicasAdopt]({
            project: "repo",
            session: "N-manual",
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
        expect(
          yield* denied[MESH_WS_METHODS.replicasUnmanaged]({}).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
        expect(
          yield* denied[MESH_WS_METHODS.replicasStatus]({}).pipe(Stream.runCollect, Effect.flip),
        ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
        const allowed = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handlers, RpcAuthorization.layer([AuthOrchestrationOperateScope])),
          ),
        );
        expect(
          yield* allowed[MESH_WS_METHODS.replicasStatus]({}).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ).toMatchObject([{ replicas: [{ logicalKey: "repo", state: "mounting" }] }]);
        expect(yield* allowed[MESH_WS_METHODS.replicasUnmanaged]({})).toEqual([]);
        h.setSession({ paused: true });
        expect(
          yield* allowed[MESH_WS_METHODS.replicasRetry]({
            logicalKey: "repo",
            environmentId: "replica",
          }),
        ).toMatchObject({ logicalKey: "repo", state: "mounting" });
        expect(clientRpcRequiredScopes(MESH_WS_METHODS.replicasAdopt, {})).toEqual([
          AuthOrchestrationOperateScope,
        ]);
        expect(clientRpcRequiredScopes(MESH_WS_METHODS.replicasUnmanaged, {})).toEqual([
          AuthOrchestrationOperateScope,
        ]);
        expect(clientRpcRequiredScopes(MESH_WS_METHODS.replicasRetry, {})).toEqual([
          AuthOrchestrationOperateScope,
        ]);
        expect(clientRpcRequiredScopes(MESH_WS_METHODS.replicasStatus, {})).toEqual([
          AuthOrchestrationOperateScope,
        ]);
      }).pipe(Effect.provide(h.layer));
    }),
);
