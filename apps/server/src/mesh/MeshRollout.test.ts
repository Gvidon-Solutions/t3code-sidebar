import * as MeshTestServices from "../../testFixtures/meshServices.ts";
import { DeliveryAdmission } from "./DeliveryAdmission.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { MeshTrialFailureExit } from "../platform/ServerPlatform.ts";
import { MeshStateBackup } from "./MeshStateBackup.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
  DeliveryDrainError,
  MeshConfigError,
  MeshUpdateVoteInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { ServerSelfUpdate } from "../cloud/selfUpdate.ts";
import {
  type ServiceUpdateRecord,
  SERVICE_LAUNCHER_CONTEXT_ENV,
} from "../cloud/serviceProtocol.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import { ReplicaRuntime } from "../replicas/ReplicaRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as Layout from "../../testFixtures/MeshLayoutTestLayer.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import * as Rollout from "./MeshRollout.ts";
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const decodeVote = Schema.decodeUnknownEffect(MeshUpdateVoteInput);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesh-rollout-" });
  const mesh = yield* MeshLayoutService;
  const services = new Map<string, Rollout.MeshRollout["Service"]>();
  const requested: string[] = [];
  const deadlines: number[] = [];
  const forced: boolean[] = [];
  const steps: string[] = [];
  const backupBlocks = new Map<string, Effect.Effect<void>>();
  const drainBlocks = new Map<string, Effect.Effect<void>>();
  const cancelled: string[] = [];
  const h = yield* mesh.nextHlc;
  const doc = {
    schema: 1,
    t3: { version: "0.1.6" },
    machines: { studio: {}, cloudbox: {}, laptop: {} },
  };
  yield* mesh.apply({
    "mesh.config": { h, v: { revision: "r1", doc, author: "studio", writtenAt: "" } },
    ...Object.fromEntries(
      Object.keys(doc.machines).map((name) => [`mesh.machineBinding/${name}`, { h, v: name }]),
    ),
  });
  yield* mesh.edit((current) => ({
    ...current,
    machines: Object.fromEntries(
      Object.keys(doc.machines).map((name) => [
        name,
        {
          reported: {
            version: "0.1.5",
            platform: { os: "linux", arch: "x64", release: "test" },
            user: name,
            sshd: null,
            reportedAt: "",
          },
        },
      ]),
    ),
  }));
  const client: PeerMcpClient["Service"] = {
    connectionAvailable: () => Effect.succeed(true),
    call: (input) =>
      Effect.gen(function* () {
        const destination = services.get(input.environmentId);
        if (!destination) return yield* Effect.die("Unknown fixture peer");
        const value =
          input.tool === "t3_mesh_update_vote"
            ? yield* destination.vote(yield* decodeVote(input.arguments))
            : yield* destination.health;
        return value as typeof input.success.Type;
      }).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Fixture peer call failed",
            }),
        ),
      ),
  };
  const make = Effect.fn("test.rollout.make")(function* (
    id: string,
    version: string,
    update?: ServiceUpdateRecord,
    fail = false,
    withAdmission = true,
  ) {
    const base = `${root}/${id}`;
    yield* fs.makeDirectory(base, { recursive: true });
    const environment: NodeJS.ProcessEnv = {
      ...(update
        ? {
            [SERVICE_LAUNCHER_CONTEXT_ENV]: yield* encode({
              protocol: 3,
              childVersion: version,
              update: { ...update },
            }),
          }
        : {}),
      T3_MESH_TEST_MODE: "1",
      T3_MESH_TEST_FAIL_HEALTH_VERSION: version,
    };
    const openDrain = {
      requestId: null,
      phase: "open" as const,
      deadlineAt: null,
      activeRuns: 0,
      pendingStarts: 0,
    };
    const dependencies = Layer.mergeAll(
      withAdmission
        ? Layer.mock(DeliveryAdmission)({
            drain: ({ requestId, deadlineMs, now }) =>
              Effect.sync(() => {
                steps.push(`drain/${id}`);
                deadlines.push(deadlineMs);
                forced.push(now === true);
                return { ...openDrain, requestId, phase: "drained" as const };
              }).pipe(Effect.tap(() => drainBlocks.get(id) ?? Effect.void)),
            cancel: () =>
              Effect.sync(() => {
                cancelled.push(id);
                return openDrain;
              }),
            status: Effect.succeed(openDrain),
          })
        : Layer.mock(DeliveryAdmission)({
            cancel: () =>
              Effect.sync(() => {
                cancelled.push(id);
                return openDrain;
              }),
            drain: () =>
              Effect.fail(new DeliveryDrainError({ message: "Delivery admission is unavailable" })),
            status: Effect.fail(
              new DeliveryDrainError({ message: "Delivery admission is unavailable" }),
            ),
          }),
      Layer.succeed(MeshLayoutService, { ...mesh, environmentId: id }),
      ServerConfig.layerTest(base, base),
      Layer.succeed(PeerMcpClient, client),
      Layer.mock(PeerLinks)({}),
      Layer.mock(ReplicaRuntime)({ get: Effect.die("Unexpected replica startup") }),
      Layer.succeed(MeshStateBackup, {
        create: () =>
          Effect.gen(function* () {
            expect(steps.at(-1)).toBe(`drain/${id}`);
            steps.push(`backup/${id}`);
            yield* backupBlocks.get(id) ?? Effect.void;
          }),
      }),
      Layer.mock(ServerSelfUpdate)({
        update: (input) =>
          Effect.gen(function* () {
            expect((yield* mesh.read).document["mesh.updateLease"]?.v).toMatchObject({
              owner: id,
              target: input.targetVersion,
            });
            expect(steps.at(-1)).toBe(`backup/${id}`);
            steps.push(`download/${id}`);
            requested.push(id);
            return {
              targetVersion: input.targetVersion,
              method: "boot-service" as const,
              updateId: "u1",
            };
          }),
      }),
    );
    const service = yield* Rollout.MeshRollout.pipe(
      Effect.provide(
        (fail
          ? Rollout.layerTest(
              Effect.fail(
                new MeshConfigError({
                  reason: "storage",
                  message: "Injected mesh rollout health failure",
                }),
              ),
            )
          : Rollout.layer
        ).pipe(Layer.provide(dependencies)),
      ),
      Effect.provideService(HostProcess.Environment, environment),
      Effect.provideService(Rollout.MeshRuntimeVersion, version),
      Effect.provideService(MeshTrialFailureExit, Effect.void),
    );
    services.set(id, service);
    return service;
  });
  for (const id of Object.keys(doc.machines)) yield* make(id, "0.1.5");
  return {
    mesh,
    make,
    services,
    requested,
    root,
    fs,
    backupBlocks,
    drainBlocks,
    cancelled,
    steps,
    deadlines,
    forced,
  };
});
const testLayer = Layout.layerTest("studio", DEFAULT_SIDEBAR_WORKSPACES_CONFIG).pipe(
  Layer.provideMerge(Layer.merge(NodeServices.layer, MeshTestServices.platform)),
);
it.effect(
  "serializes concurrent candidates and releases each lease only after the new version passes health",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.forEach(
        [...f.services.values()],
        (service) => service.reconcile.pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      yield* f.services.get("cloudbox")!.reconcile;
      expect(f.requested).toEqual(["cloudbox"]);
      for (const id of ["cloudbox", "laptop", "studio"]) {
        if (id !== "cloudbox") yield* f.services.get(id)!.reconcile;
        const trial = yield* f.make(id, "0.1.6", {
          id: `update-${id}`,
          status: "pending",
          fromVersion: "0.1.5",
          targetVersion: "0.1.6",
          dbPath: `${f.root}/${id}/userdata/statev2.sqlite`,
        });
        yield* f.mesh.edit((current) => ({
          ...current,
          machines: {
            ...current.machines,
            [id]: {
              ...current.machines[id],
              reported: { ...current.machines[id]!.reported!, version: "0.1.6" },
            },
          },
        }));
        yield* trial.checkTrial;
        yield* trial.finishTrial;
        expect((yield* f.mesh.read).document["mesh.updateLease"]?.v).toBeNull();
      }
      expect(f.requested).toEqual(["cloudbox", "laptop", "studio"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          Layer.provideMerge(testLayer, MeshTestServices.platform),
          MeshTestServices.services,
        ),
      ),
    ),
);
it.effect(
  "persists the health failure across a database restore, stops the rollout and leaves later servers untouched",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.services.get("cloudbox")!.reconcile;
      const trial = yield* f.make(
        "cloudbox",
        "0.1.6",
        {
          id: "u1",
          status: "pending",
          fromVersion: "0.1.5",
          targetVersion: "0.1.6",
          dbPath: "unused",
        },
        true,
      );
      expect((yield* trial.checkTrial.pipe(Effect.flip)).message).toContain("Injected");
      const old = yield* f.make("cloudbox", "0.1.5", {
        id: "u1",
        status: "rolled-back",
        fromVersion: "0.1.5",
        targetVersion: "0.1.6",
        reason: "candidate-exited:1",
      });
      expect((yield* old.reconcile.pipe(Effect.flip)).message).toContain("Injected");
      expect((yield* f.mesh.read).document["mesh.updateFailure/r1"]?.v).toMatchObject({
        reason: "Injected mesh rollout health failure",
      });
      expect((yield* f.services.get("laptop")!.reconcile.pipe(Effect.flip)).message).toContain(
        "Rollout stopped",
      );
      expect(f.requested).toEqual(["cloudbox"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          Layer.provideMerge(testLayer, MeshTestServices.platform),
          MeshTestServices.services,
        ),
      ),
    ),
);

it.effect("resumes the same lease after interruption before the launcher accepts the handoff", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const reached = yield* Deferred.make<void>();
    const blocked = yield* Deferred.make<void>();
    f.backupBlocks.set(
      "cloudbox",
      Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(blocked))),
    );
    const first = yield* Effect.forkChild(f.services.get("cloudbox")!.reconcile, {
      startImmediately: true,
    });
    yield* Deferred.await(reached);
    yield* Fiber.interrupt(first);
    f.backupBlocks.delete("cloudbox");
    yield* f.services.get("cloudbox")!.reconcile;
    expect(f.requested).toEqual(["cloudbox"]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        Layer.provideMerge(testLayer, MeshTestServices.platform),
        MeshTestServices.services,
      ),
    ),
  ),
);

it.effect("refuses runtime handoff before backup when admission fails", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* f.make("cloudbox", "0.1.5", undefined, false, false);
    const failure = yield* service.reconcile.pipe(Effect.flip);
    expect(failure.message).toContain("Delivery admission is unavailable");
    expect(f.requested).toEqual([]);
    expect(f.steps).toEqual([]);
    expect((yield* f.mesh.read).document["mesh.updateLease"]?.v).toBeNull();
    expect(f.cancelled).toContain("cloudbox");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        Layer.provideMerge(testLayer, MeshTestServices.platform),
        MeshTestServices.services,
      ),
    ),
  ),
);

it.effect(
  "reopens admission without backup or switch when draining exhausts the lease handoff window",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.drainBlocks.set(
        "cloudbox",
        Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const pending = yield* f.services.get("cloudbox")!.reconcile.pipe(
        Effect.match({
          onFailure: (error) => error.message,
          onSuccess: () => "Runtime switched",
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(reached);
      yield* TestClock.adjust("19 minutes");
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(pending)).toContain("enough time after draining");
      expect(f.steps).toEqual(["drain/cloudbox"]);
      expect(f.requested).toEqual([]);
      expect(f.cancelled).toEqual(["cloudbox"]);
      expect((yield* f.mesh.read).document["mesh.updateLease"]?.v).toBeNull();
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          Layer.provideMerge(testLayer, MeshTestServices.platform),
          MeshTestServices.services,
        ),
      ),
    ),
);

it.effect.each([
  { maxWaitMs: 1234, skipForVersion: undefined, expected: [1234] },
  { maxWaitMs: 1234, skipForVersion: "0.1.6", expected: [1234] },
  { maxWaitMs: 1234, skipForVersion: "0.1.5", expected: [1234] },
])("uses the configured drain deadline and honors skip only for the exact target: %j", (policy) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const h = yield* f.mesh.nextHlc;
    yield* f.mesh.apply({
      "mesh.config": {
        h,
        v: {
          revision: "r1",
          author: "studio",
          writtenAt: "",
          doc: {
            schema: 1,
            machines: { studio: {}, cloudbox: {}, laptop: {} },
            t3: {
              version: "0.1.6",
              drain: {
                maxWaitMs: policy.maxWaitMs,
                ...(policy.skipForVersion ? { skipForVersion: policy.skipForVersion } : {}),
              },
            },
          },
        },
      },
    });
    yield* f.services.get("cloudbox")!.reconcile;
    expect(f.deadlines).toEqual(policy.expected);
    expect(f.forced).toEqual([policy.skipForVersion === "0.1.6"]);
    expect(f.requested).toEqual(["cloudbox"]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.provideMerge(
        Layer.provideMerge(testLayer, MeshTestServices.platform),
        MeshTestServices.services,
      ),
    ),
  ),
);
