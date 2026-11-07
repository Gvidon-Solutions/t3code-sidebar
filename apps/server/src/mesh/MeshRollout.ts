import { meshMillis } from "./MeshTiming.ts";
import { DeliveryAdmission } from "./DeliveryAdmission.ts";
import * as Option from "effect/Option";
import { MeshTrialFailureExit } from "../platform/ServerPlatform.ts";
import { MeshStateBackup } from "./MeshStateBackup.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { parseServiceState } from "../cloud/serviceProtocol.ts";
import { callRouted } from "./MeshRouting.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import {
  EnvironmentId,
  MeshConfigError,
  MeshUpdateVoteInput,
  MeshUpdateHealth,
  MeshConfigRevision,
} from "@t3tools/contracts";
import { bindingsFromLayout } from "@t3tools/shared/meshConfig";
import type { Json } from "@t3tools/shared/meshLayout";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";

import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import { ServerSelfUpdate } from "../cloud/selfUpdate.ts";
import {
  decodeServiceLauncherContext,
  SERVICE_LAUNCHER_CONTEXT_ENV,
} from "../cloud/serviceProtocol.ts";
import { ReplicaRuntime } from "../replicas/ReplicaRuntime.ts";
import { MeshLayoutService } from "./MeshLayoutService.ts";
import packageJson from "../../package.json" with { type: "json" };

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const Marker = Schema.Struct({
  revision: Schema.String,
  token: Schema.String,
  target: Schema.String,
  previousUpdateId: Schema.NullOr(Schema.String),
});
const Failure = Schema.Struct({ updateId: Schema.String, reason: Schema.String });

const decodeMarker = Schema.decodeEffect(Schema.fromJsonString(Marker));
const decodeFailure = Schema.decodeEffect(Schema.fromJsonString(Failure));
export const MeshRuntimeVersion = Context.Reference<string>("t3/mesh/runtimeVersion", {
  defaultValue: () => packageJson.version,
});

type Vote = typeof MeshUpdateVoteInput.Type;
const decodeVote = Schema.decodeUnknownOption(MeshUpdateVoteInput);
const decodeRevision = Schema.decodeUnknownOption(MeshConfigRevision);
const limits = { runtimeMode: "full-access" as const, interactionMode: "default" as const };
const stable = (key: string) =>
  !key.startsWith("machine/") &&
  !key.startsWith("mesh.configStatus/") &&
  !key.startsWith("mesh.update") &&
  !key.startsWith("mesh.bootstrapStatus/") &&
  !key.startsWith("repstatus/");
export class MeshRollout extends Context.Service<
  MeshRollout,
  {
    readonly trial: boolean;
    readonly vote: (input: Vote) => Effect.Effect<boolean, MeshConfigError>;
    readonly health: Effect.Effect<typeof MeshUpdateHealth.Type, MeshConfigError>;
    readonly reconcile: Effect.Effect<void, MeshConfigError>;
    readonly finishTrial: Effect.Effect<void, MeshConfigError>;
    readonly checkTrial: Effect.Effect<void, MeshConfigError>;
  }
>()("t3/mesh/MeshRollout") {}
export const layer = Layer.effect(
  MeshRollout,
  Effect.gen(function* () {
    const mesh = yield* MeshLayoutService;
    const failTrial = yield* MeshTrialFailureExit;
    const version = yield* MeshRuntimeVersion;
    const peer = yield* PeerMcpClient;
    const links = yield* PeerLinks;
    const routed = <S extends Schema.Decoder<unknown>>(input: Parameters<typeof peer.call<S>>[0]) =>
      callRouted({ links, peers: peer, self: mesh.environmentId }, input);
    const selfUpdate = yield* ServerSelfUpdate;
    const admission = yield* Effect.serviceOption(DeliveryAdmission);
    const backup = yield* MeshStateBackup;
    const replicas = yield* ReplicaRuntime;
    const env = yield* HostProcess.Environment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const markerFile = path.join(config.baseDir, "runtime/mesh-rollout.json");
    const healthFailureFile = path.join(config.baseDir, "runtime/mesh-health-failure.json");
    const atomic = Effect.fn("MeshRollout.persistMarker")(function* (
      filePath: string,
      value: Json,
    ) {
      const contents = yield* encodeJson(value);
      yield* writeFileStringAtomically({ filePath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    });
    const context = decodeServiceLauncherContext(env[SERVICE_LAUNCHER_CONTEXT_ENV] ?? "");
    const lock = yield* Semaphore.make(1);
    const reconcileLock = yield* Semaphore.make(1);
    let handoffRequested = false;
    let committed = context?.update?.status !== "pending";
    const voteKey = `mesh.updateVote/${encodeURIComponent(mesh.environmentId)}`;
    const read = Effect.gen(function* () {
      const snapshot = yield* mesh.read;
      const decoded = decodeRevision(snapshot.document["mesh.config"]?.v);
      return { snapshot, revision: decoded._tag === "Some" ? decoded.value : undefined };
    });
    const write = Effect.fn("MeshRollout.write")(function* (key: string, value: Json) {
      const h = yield* mesh.nextHlc;
      yield* mesh.apply({ [key]: { h, v: value } });
    });
    const failedKey = (revision: string) => `mesh.updateFailure/${encodeURIComponent(revision)}`;
    const first = (
      state: typeof read extends Effect.Effect<infer A, infer _E, infer _R> ? A : never,
    ) => {
      if (!state.revision?.doc.t3?.version) return undefined;
      const bound = bindingsFromLayout(state.snapshot.document);
      return Object.keys(state.revision.doc.machines)
        .sort()
        .map((name) => bound[name])
        .find(
          (id) =>
            id &&
            (id === mesh.environmentId
              ? version
              : state.snapshot.config.machines[id]?.reported?.version) !==
              state.revision!.doc.t3!.version,
        );
    };
    const vote = Effect.fn("MeshRollout.vote")(
      function* (input: Vote) {
        const old = decodeVote((yield* mesh.read).document[voteKey]?.v);
        if (input.release) {
          if (
            old._tag === "Some" &&
            old.value.token === input.token &&
            old.value.owner === input.owner
          )
            yield* write(voteKey, null);
          return true;
        }
        const state = yield* read;
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        if (
          state.revision?.revision !== input.revision ||
          state.revision.doc.t3?.version !== input.target ||
          first(state) !== input.owner ||
          input.expiresAt <= now ||
          input.expiresAt > now + 35 * 60_000
        )
          return false;
        // Expiry fences a stale owner; a different owner still needs an explicit release, including after a partition.
        if (old._tag === "Some" && old.value.token !== input.token) return false;
        yield* write(voteKey, { ...input } as Json);
        return true;
      },
      lock.withPermits(1),
      Effect.mapError(
        () => new MeshConfigError({ reason: "storage", message: "Cannot persist update vote" }),
      ),
    );
    const health = Effect.gen(function* () {
      const { snapshot, revision } = yield* read;
      const own = Object.entries(snapshot.config.projectMounts).flatMap(([key, reps]) =>
        reps
          .filter((rep) => rep.environmentId === mesh.environmentId && rep.role === "replica")
          .map(() => snapshot.config.projectMountStatus[key]?.[mesh.environmentId]?.state),
      );
      return {
        version: version,
        revision: revision?.revision ?? null,
        entries: Object.fromEntries(
          Object.entries(snapshot.document)
            .filter(([key]) => stable(key))
            .map(([key, entry]) => [key, entry.h]),
        ),
        replicasReady: own.every((state) => state === "watching" || state === "paused"),
      };
    }).pipe(
      Effect.mapError(
        () => new MeshConfigError({ reason: "storage", message: "Cannot read rollout health" }),
      ),
    );
    const release = Effect.fn("MeshRollout.release")(function* (
      lease: Vote,
      ids: readonly string[],
    ) {
      for (const id of lease.participants ?? ids) {
        if (id === mesh.environmentId) yield* vote({ ...lease, release: true });
        else
          yield* routed({
            environmentId: EnvironmentId.make(id),
            tool: "t3_mesh_update_vote",
            arguments: { ...lease, release: true },
            limits,
            success: Schema.Boolean,
          });
      }
      const current = decodeVote((yield* mesh.read).document["mesh.updateLease"]?.v);
      if (current._tag === "Some" && current.value.token === lease.token)
        yield* write("mesh.updateLease", null);
    });
    const finishFailure = Effect.fn("MeshRollout.finishFailure")(function* () {
      if (
        !context?.update ||
        context.update.status === "pending" ||
        context.update.status === "committed"
      )
        return;
      const { snapshot, revision } = yield* read;
      if (!revision || revision.doc.t3?.version !== context.update.targetVersion) return;
      if (!(yield* fs.exists(markerFile))) return;
      const marker = yield* decodeMarker(yield* fs.readFileString(markerFile));
      if (marker.previousUpdateId === context.update.id) return;
      if (Option.isSome(admission)) yield* admission.value.cancel(`mesh:${marker.token}`);
      let reason = context.update.reason ?? context.update.status;
      if (yield* fs.exists(healthFailureFile)) {
        const failure = yield* decodeFailure(yield* fs.readFileString(healthFailureFile));
        if (failure.updateId === context.update.id) reason = failure.reason;
      }
      yield* write(failedKey(marker.revision), {
        environmentId: mesh.environmentId,
        reason,
        target: context.update.targetVersion,
      });
      const decoded = decodeVote(snapshot.document["mesh.updateLease"]?.v);
      if (
        decoded._tag === "Some" &&
        decoded.value.owner === mesh.environmentId &&
        decoded.value.token === marker.token
      )
        yield* release(decoded.value, [
          ...new Set(Object.values(bindingsFromLayout(snapshot.document))),
        ]);
    });
    const reconcile = Effect.gen(function* () {
      if (handoffRequested) return;
      yield* finishFailure();
      const state = yield* read;
      const { snapshot, revision } = state;
      const target = revision?.doc.t3?.version;
      if (!revision || !target || revision.doc.schema !== 1) return;
      const failure = snapshot.document[failedKey(revision.revision)]?.v;
      if (failure)
        return yield* new MeshConfigError({
          reason: "storage",
          message: `Rollout stopped: ${typeof failure === "object" && "reason" in failure && typeof failure.reason === "string" ? failure.reason : "failed health check"}; apply a new config revision to retry`,
        });
      if (version === target) {
        const lease = decodeVote(snapshot.document["mesh.updateLease"]?.v);
        if (lease._tag === "Some" && lease.value.owner === mesh.environmentId && committed)
          yield* release(lease.value, [
            ...new Set(Object.values(bindingsFromLayout(snapshot.document))),
          ]);
        return;
      }
      if (Option.isNone(admission))
        return yield* new MeshConfigError({
          reason: "storage",
          message: "Delivery admission is unavailable; refusing runtime update",
        });
      const drainAdmission = admission.value;
      if (first(state) !== mesh.environmentId)
        return yield* new MeshConfigError({
          reason: "storage",
          message: "Waiting for the preceding machine in the rolling update",
        });
      const bound = bindingsFromLayout(snapshot.document);
      if (Object.keys(revision.doc.machines).some((name) => !bound[name]))
        return yield* new MeshConfigError({
          reason: "storage",
          message: "Waiting for configured machines to join before updating",
        });
      const ids = [
        ...new Set(Object.keys(revision.doc.machines).map((name) => bound[name]!)),
      ].sort();
      const existing = decodeVote(snapshot.document["mesh.updateLease"]?.v);
      const localVote = decodeVote(snapshot.document[voteKey]?.v);
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const lease: Vote =
        existing._tag === "Some"
          ? existing.value
          : localVote._tag === "Some"
            ? localVote.value
            : {
                owner: mesh.environmentId,
                revision: revision.revision,
                target,
                token: yield* mesh.nextHlc,
                participants: ids,
                expiresAt: now + 30 * 60_000,
              };
      if (
        lease.owner === mesh.environmentId &&
        (lease.revision !== revision.revision || lease.expiresAt <= now)
      ) {
        const stateFile = path.join(config.baseDir, "runtime/service-state.json");
        const state = (yield* fs.exists(stateFile))
          ? parseServiceState(yield* fs.readFileString(stateFile))
          : undefined;
        if (
          (state !== undefined || !(yield* fs.exists(stateFile))) &&
          state?.update?.status !== "pending"
        ) {
          yield* release(lease, ids);
          return yield* new MeshConfigError({
            reason: "storage",
            message: "Recovered an expired or superseded update lease; reconciliation will retry",
          });
        }
      }
      if (
        lease.owner !== mesh.environmentId ||
        lease.revision !== revision.revision ||
        lease.expiresAt <= now
      )
        return yield* new MeshConfigError({
          reason: "storage",
          message:
            "Update lease is occupied or expired; its owner must finish recovery before the rollout can proceed",
        });
      for (const id of ids) {
        const granted =
          id === mesh.environmentId
            ? yield* vote(lease)
            : yield* routed({
                environmentId: EnvironmentId.make(id),
                tool: "t3_mesh_update_vote",
                arguments: { ...lease },
                limits,
                success: Schema.Boolean,
              });
        if (!granted)
          return yield* new MeshConfigError({
            reason: "storage",
            message: "Waiting for every machine to grant the update lease",
          });
      }
      yield* write("mesh.updateLease", { ...lease } as Json);
      if (DateTime.toEpochMillis(yield* DateTime.now) >= lease.expiresAt - 12 * 60_000)
        return yield* new MeshConfigError({
          reason: "storage",
          message: "Update lease does not have enough time for a safe handoff",
        });
      yield* atomic(markerFile, {
        revision: revision.revision,
        token: lease.token,
        target,
        previousUpdateId: context?.update?.id ?? null,
      });
      yield* drainAdmission
        .drain({
          requestId: `mesh:${lease.token}`,
          deadlineMs: revision.doc.t3?.drain?.maxWaitMs ?? 300000,
          now: revision.doc.t3?.drain?.skipForVersion === target,
        })
        .pipe(
          Effect.andThen(
            Effect.gen(function* () {
              if (DateTime.toEpochMillis(yield* DateTime.now) >= lease.expiresAt - 12 * 60_000)
                return yield* new MeshConfigError({
                  reason: "storage",
                  message:
                    "Update lease no longer has enough time after draining; runtime stays running",
                });
            }),
          ),
          Effect.andThen(backup.create(lease.token)),
          Effect.andThen(
            selfUpdate.update({ targetVersion: target }, undefined, () =>
              Effect.sync(() => {
                handoffRequested = true;
              }),
            ),
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              handoffRequested = true;
            }),
          ),
          Effect.tapError((error) =>
            Effect.gen(function* () {
              handoffRequested = false;
              if (Option.isSome(admission))
                yield* admission.value.cancel(`mesh:${lease.token}`).pipe(Effect.orDie);
              yield* write(failedKey(revision.revision), {
                environmentId: mesh.environmentId,
                target,
                reason: error.message,
              });
              yield* release(lease, ids);
            }),
          ),
        );
    }).pipe(
      reconcileLock.withPermits(1),
      Effect.mapError((error) =>
        error._tag === "MeshConfigError"
          ? error
          : new MeshConfigError({
              reason: "storage",
              message: `Rolling update failed: ${error.message}`,
            }),
      ),
    );
    const checkTrial = Effect.gen(function* () {
      if (context?.update?.status !== "pending") return;
      const { snapshot, revision } = yield* read;
      const lease = decodeVote(snapshot.document["mesh.updateLease"]?.v);
      if (lease._tag === "None" || lease.value.owner !== mesh.environmentId) return;
      if (
        !revision ||
        revision.doc.schema !== 1 ||
        revision.doc.t3?.version !== version ||
        revision.revision !== lease.value.revision
      )
        return yield* new MeshConfigError({
          reason: "storage",
          message: "Desired config changed during the runtime trial",
        });
      if (env.T3_MESH_TEST_MODE === "1" && env.T3_MESH_TEST_FAIL_HEALTH_VERSION === version)
        return yield* new MeshConfigError({
          reason: "storage",
          message: "Injected mesh rollout health failure",
        });
      const ownsReplicas = Object.values(snapshot.config.projectMounts).some((reps) =>
        reps.some((rep) => rep.environmentId === mesh.environmentId && rep.role === "replica"),
      );
      const replicaService = ownsReplicas ? yield* replicas.get : undefined;
      const check = Effect.gen(function* () {
        if (replicaService) yield* replicaService.reconcile;
        const local = yield* health;
        if (!local.replicasReady)
          return yield* new MeshConfigError({
            reason: "storage",
            message: `Replicas have not resumed: ${Object.entries(
              (yield* mesh.read).config.projectMountStatus,
            )
              .flatMap(([key, states]) => {
                const state = states[mesh.environmentId];
                return state && state.state !== "watching" && state.state !== "paused"
                  ? [`${key}: ${state.state}${state.message ? ` (${state.message})` : ""}`]
                  : [];
              })
              .join("; ")}`,
          });
        for (const id of [
          ...new Set(Object.values(bindingsFromLayout((yield* mesh.read).document))),
        ].filter((id) => id !== mesh.environmentId)) {
          const other = yield* routed({
            environmentId: EnvironmentId.make(id),
            tool: "t3_mesh_update_health",
            arguments: {},
            limits,
            success: MeshUpdateHealth,
          });
          if (
            other.revision !== local.revision ||
            Object.entries(local.entries).some(([key, h]) => (other.entries[key] ?? "") < h) ||
            Object.entries(other.entries).some(([key, h]) => (local.entries[key] ?? "") < h)
          )
            return yield* new MeshConfigError({
              reason: "storage",
              message: "Layout has not converged with peers",
            });
        }
      });
      yield* check.pipe(
        Effect.retry({ schedule: Schedule.spaced(meshMillis(500)), times: 180 }),
        Effect.timeout(meshMillis(120_000)),
      );
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "MeshConfigError"
          ? error
          : new MeshConfigError({
              reason: "storage",
              message: "Mesh rollout trial health check failed",
            }),
      ),
      Effect.tapError((error) =>
        context?.update?.status === "pending"
          ? atomic(healthFailureFile, { updateId: context.update.id, reason: error.message }).pipe(
              Effect.ensuring(failTrial),
              Effect.mapError(
                () =>
                  new MeshConfigError({
                    reason: "storage",
                    message: "Cannot persist rollout health failure",
                  }),
              ),
            )
          : Effect.void,
      ),
    );
    const finishTrial = Effect.gen(function* () {
      committed = true;
      if (Option.isSome(admission)) {
        const current = yield* admission.value.status;
        if (current.requestId?.startsWith("mesh:"))
          yield* admission.value.cancel(current.requestId);
      }
      const { snapshot } = yield* read;
      const lease = decodeVote(snapshot.document["mesh.updateLease"]?.v);
      if (
        lease._tag === "Some" &&
        lease.value.owner === mesh.environmentId &&
        lease.value.target === version
      )
        yield* release(lease.value, [
          ...new Set(Object.values(bindingsFromLayout(snapshot.document))),
        ]);
    }).pipe(
      Effect.mapError(
        () =>
          new MeshConfigError({
            reason: "storage",
            message: "Cannot release the committed update lease",
          }),
      ),
    );
    return MeshRollout.of({
      trial: context?.update?.status === "pending",
      vote,
      health,
      reconcile,
      checkTrial,
      finishTrial,
    });
  }),
);
