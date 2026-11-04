import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  EnvironmentId,
  MESH_WS_METHODS,
  type MeshLayoutSnapshot,
} from "@t3tools/contracts";
import { keys, tick } from "@t3tools/shared/meshLayout";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createMeshLayoutAtoms } from "./meshLayoutClient.ts";

it.effect(
  "updates network status from pushed machine facts without waiting for the status polling interval",
  () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("studio");
      const machineKey = keys.machine(environmentId);
      const initialHlc = tick(0, null, environmentId);
      const snapshot: MeshLayoutSnapshot = {
        environmentId,
        config: { ...DEFAULT_SIDEBAR_WORKSPACES_CONFIG, machines: { [environmentId]: {} } },
        document: { [machineKey]: { h: initialHlc, v: {} } },
      };
      const snapshots = yield* SubscriptionRef.make(snapshot);
      const refreshed = yield* Deferred.make<void>();
      let offline = false;
      const rpcSession = {
        client: {
          [MESH_WS_METHODS.layoutSubscribe]: () => SubscriptionRef.changes(snapshots),
          [MESH_WS_METHODS.status]: () =>
            Effect.gen(function* () {
              if (offline) yield* Deferred.succeed(refreshed, undefined);
              return {
                peers: [],
                connections: [
                  {
                    environmentId: "cloudbox",
                    sourceEnvironmentId: environmentId,
                    state: offline ? ("offline" as const) : ("direct" as const),
                    via: null,
                    direction: offline ? null : ("outbound" as const),
                    connectedAt: offline ? null : "2026-11-04T00:00:00.000Z",
                    offlineSince: offline ? "2026-11-04T00:01:00.000Z" : null,
                    lastError: offline ? "Peer heartbeat timed out" : null,
                  },
                ],
              };
            }),
        },
      } as unknown as RpcSession;
      const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected" as const,
        generation: 1,
      });
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "studio",
          httpBaseUrl: "https://studio.test",
          wsBaseUrl: "wss://studio.test",
        }),
        state,
        session: yield* SubscriptionRef.make(Option.some(rpcSession)),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
        _id,
        stream,
      ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const environmentRegistry = {
        run,
        followStream,
        stateChanges: () => SubscriptionRef.changes(state),
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
      const runtime = Atom.runtime(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      );
      const atoms = createMeshLayoutAtoms(runtime);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const target = { environmentId, input: {} };
      registry.mount(atoms.subscribe(target));
      yield* AtomRegistry.getResult(registry, atoms.subscribe(target));
      registry.mount(atoms.status(target));
      expect(
        (yield* AtomRegistry.getResult(registry, atoms.status(target), { suspendOnWaiting: true }))
          .connections?.[0]?.state,
      ).toBe("direct");
      offline = true;
      yield* SubscriptionRef.set(snapshots, {
        ...snapshot,
        document: { [machineKey]: { h: tick(1, initialHlc, environmentId), v: {} } },
      });
      yield* Deferred.await(refreshed);
      const updated = yield* AtomRegistry.toStreamResult(registry, atoms.status(target)).pipe(
        Stream.filter((value) => value.connections?.[0]?.state === "offline"),
        Stream.runHead,
      );
      expect(Option.getOrThrow(updated).connections?.[0]).toMatchObject({
        state: "offline",
        lastError: "Peer heartbeat timed out",
      });
    }).pipe(Effect.scoped),
);
