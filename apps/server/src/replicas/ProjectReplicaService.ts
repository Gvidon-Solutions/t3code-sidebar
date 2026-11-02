import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import {
  CommandId,
  ProjectId,
  ReplicaError,
  type ReplicaLiveStatus,
  type ReplicaRefInput,
  type SidebarProjectMount,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { MeshLayoutService } from "../mesh/MeshLayoutService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MutagenRunner from "./MutagenRunner.ts";
import { syncManagedSshConfig } from "./ManagedSshConfig.ts";
import { replicaDriver, sessionIdentity, sessionStatus, sshEndpoint } from "./replicaModel.ts";

export class ProjectReplicaService extends Context.Service<
  ProjectReplicaService,
  {
    readonly reconcile: Effect.Effect<void, ReplicaError>;
    readonly status: Effect.Effect<ReadonlyArray<ReplicaLiveStatus>>;
    readonly changes: Stream.Stream<{ readonly replicas: ReadonlyArray<ReplicaLiveStatus> }>;
    readonly retry: (input: ReplicaRefInput) => Effect.Effect<ReplicaLiveStatus, ReplicaError>;
  }
>()("t3/replicas/ProjectReplicaService") {}

const isReplicaError = Schema.is(ReplicaError);

const make = Effect.gen(function* () {
  const mesh = yield* MeshLayoutService;
  const runner = yield* MutagenRunner.MutagenRunner;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const home = yield* HostProcess.HomeDirectory;
  const locks = yield* KeyedLock.make<string>();
  const statuses = yield* Ref.make<ReadonlyArray<ReplicaLiveStatus>>([]);
  const updates = yield* PubSub.unbounded<{
    readonly replicas: ReadonlyArray<ReplicaLiveStatus>;
  }>();
  const known = new Map<string, string>();
  const refKey = (logicalKey: string, environmentId: string) => `${logicalKey}\0${environmentId}`;
  const publish = Effect.fn("ProjectReplicaService.publish")(function* (status: ReplicaLiveStatus) {
    yield* Ref.update(statuses, (all) => [
      ...all.filter(
        (row) =>
          refKey(row.logicalKey, row.environmentId) !==
          refKey(status.logicalKey, status.environmentId),
      ),
      status,
    ]);
    const current = (yield* mesh.read).config.projectMountStatus[status.logicalKey]?.[
      status.environmentId
    ];
    if (current?.state !== status.state)
      yield* mesh.edit((config) => ({
        ...config,
        projectMountStatus: {
          ...config.projectMountStatus,
          [status.logicalKey]: {
            ...config.projectMountStatus[status.logicalKey],
            [status.environmentId]: {
              state: status.state,
              conflicts: status.conflicts.length,
              ...(status.message ? { message: status.message } : {}),
              updatedAt: status.updatedAt,
            },
          },
        },
      }));
    yield* PubSub.publish(updates, { replicas: yield* Ref.get(statuses) });
  });
  const register = Effect.fn("ProjectReplicaService.register")(function* (
    logicalKey: string,
    rep: SidebarProjectMount,
  ) {
    if (rep.environmentId !== mesh.environmentId || rep.projectId) return;
    const existing = yield* projects.getByWorkspaceRoot(rep.path);
    const project = Option.isSome(existing)
      ? existing.value
      : yield* projects.create({
          commandId: CommandId.make(yield* crypto.randomUUIDv4()),
          projectId: ProjectId.make(yield* crypto.randomUUIDv4()),
          workspaceRoot: rep.path,
          title: path.basename(rep.path),
        });
    yield* mesh.edit((config) => ({
      ...config,
      projectMounts: {
        ...config.projectMounts,
        [logicalKey]: (config.projectMounts[logicalKey] ?? []).map((entry) =>
          entry.environmentId === rep.environmentId && entry.path === rep.path
            ? { ...entry, projectId: project.id }
            : entry,
        ),
      },
    }));
  });
  const reconcileOne = Effect.fn("ProjectReplicaService.reconcileOne")(function* (
    logicalKey: string,
    rep: SidebarProjectMount,
    sessions: ReadonlyArray<MutagenRunner.MutagenSession>,
  ) {
    const config = (yield* mesh.read).config;
    const driver = replicaDriver(config, rep);
    const now = DateTime.formatIso(yield* DateTime.now);
    const base = {
      logicalKey,
      environmentId: rep.environmentId,
      conflicts: [],
      problems: [],
      localPath: rep.path,
      updatedAt: now,
    } satisfies Omit<ReplicaLiveStatus, "state">;
    if (!driver) {
      if (rep.environmentId === mesh.environmentId)
        yield* publish({
          ...base,
          state: "error",
          message: `${rep.environmentId} cannot reach ${rep.source ?? "source"} and back. Add an ssh route in Settings › Machines`,
        });
      return;
    }
    if (driver !== mesh.environmentId) {
      if (
        rep.environmentId === mesh.environmentId &&
        config.projectMountStatus[logicalKey]?.[rep.environmentId]?.state === "watching"
      )
        yield* register(logicalKey, rep);
      return;
    }
    const identity = sessionIdentity(logicalKey, rep.environmentId);
    const key = refKey(logicalKey, rep.environmentId);
    const session = sessions.find(
      (candidate) =>
        candidate.name === identity.name &&
        candidate.labels?.["t3-logical"] === identity.logicalHash &&
        candidate.labels?.["t3-env"] === identity.environmentTag,
    );
    const source = config.projectMounts[logicalKey]?.find(
      (candidate) => candidate.environmentId === rep.source,
    );
    if (!source)
      return yield* new ReplicaError({
        reason: "not_found",
        message: "Replica source representation is missing.",
      });
    known.set(key, identity.name);
    if (!session) {
      yield* publish({ ...base, sessionName: identity.name, state: "pending" });
      const defaults = yield* settings.getSettings;
      const route =
        config.machines[driver]?.reach?.[
          driver === rep.environmentId ? source.environmentId : rep.environmentId
        ];
      if (!route)
        return yield* new ReplicaError({
          reason: "unreachable",
          message: "Replica SSH route is missing.",
        });
      yield* runner.create({
        ...identity,
        ignores: [...defaults.replicaIgnores, ...(rep.ignores ?? [])],
        alpha:
          driver === source.environmentId
            ? source.path
            : sshEndpoint(route, source.environmentId, source.path),
        beta:
          driver === rep.environmentId ? rep.path : sshEndpoint(route, rep.environmentId, rep.path),
      });
      yield* publish({ ...base, sessionName: identity.name, state: "mounting" });
    } else {
      const status = { ...base, sessionName: identity.name, ...sessionStatus(session) };
      yield* publish(status);
      if (status.state === "watching") yield* register(logicalKey, rep);
    }
  });
  const mapError = (cause: unknown) =>
    isReplicaError(cause)
      ? cause
      : new ReplicaError({ reason: "storage", message: "Replica reconciliation failed.", cause });
  const reconcile = Effect.fn("ProjectReplicaService.reconcile")(function* () {
    if (!(yield* settings.getSettings).replicasEnabled) return;
    const { config } = yield* mesh.read;
    const entries = Object.entries(config.projectMounts).flatMap(([logicalKey, reps]) =>
      reps
        .filter((rep) => rep.role === "replica" && rep.transport === "mutagen")
        .map((rep) => ({ logicalKey, rep })),
    );
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* syncManagedSshConfig(config.machines[mesh.environmentId]?.reach).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.HomeDirectory, home),
    );
    const sessions = yield* runner.list();
    for (const { logicalKey, rep } of entries) {
      yield* locks.withLock(
        refKey(logicalKey, rep.environmentId),
        Effect.flatMap(runner.list(), (latest) => reconcileOne(logicalKey, rep, latest)).pipe(
          Effect.catch((cause) =>
            publish({
              logicalKey,
              environmentId: rep.environmentId,
              state: "error",
              conflicts: [],
              problems: [mapError(cause).message],
              message: mapError(cause).message,
              updatedAt: now,
            }),
          ),
        ),
      );
    }
    for (const [key, name] of known)
      if (
        !entries.some(
          ({ logicalKey, rep }) =>
            key === refKey(logicalKey, rep.environmentId) &&
            replicaDriver(config, rep) === mesh.environmentId,
        )
      ) {
        if (sessions.some((session) => session.name === name))
          yield* locks.withLock(key, runner.terminate(name));
        known.delete(key);
        yield* Ref.update(statuses, (all) =>
          all.filter((row) => refKey(row.logicalKey, row.environmentId) !== key),
        );
      }
    const expected = new Set(
      entries.map(({ logicalKey, rep }) => sessionIdentity(logicalKey, rep.environmentId).name),
    );
    for (const session of sessions)
      if (session.name && !expected.has(session.name)) {
        yield* Ref.update(statuses, (all) => [
          ...all.filter((row) => row.sessionName !== session.name),
          {
            logicalKey: "",
            environmentId: mesh.environmentId,
            ...sessionStatus(session),
            sessionName: session.name!,
            message: "Orphan session: no representation; left untouched.",
            updatedAt: now,
          },
        ]);
      }
    yield* PubSub.publish(updates, { replicas: yield* Ref.get(statuses) });
  });
  const readSettings = settings.getSettings.pipe(Effect.mapError(mapError));
  return ProjectReplicaService.of({
    reconcile: reconcile().pipe(Effect.mapError(mapError)),
    status: Ref.get(statuses),
    changes: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(updates);
        const replicas = yield* Ref.get(statuses);
        return Stream.succeed({ replicas }).pipe(
          Stream.concat(Stream.fromSubscription(subscription)),
        );
      }),
    ),
    retry: Effect.fn("ProjectReplicaService.retry")(function* (input) {
      if (!(yield* readSettings).replicasEnabled)
        return yield* new ReplicaError({ reason: "disabled", message: "Replicas are disabled." });
      const rep = (yield* mesh.read).config.projectMounts[input.logicalKey]?.find(
        (entry) => entry.environmentId === input.environmentId,
      );
      if (!rep)
        return yield* new ReplicaError({ reason: "not_found", message: "Replica not found." });
      if (replicaDriver((yield* mesh.read).config, rep) !== mesh.environmentId)
        return yield* new ReplicaError({
          reason: "unreachable",
          message: "Retry on the server driving this replica.",
        });
      const name = sessionIdentity(input.logicalKey, input.environmentId).name;
      yield* locks.withLock(
        refKey(input.logicalKey, input.environmentId),
        Effect.gen(function* () {
          const sessions = yield* runner.list();
          if (sessions.some((session) => session.name === name)) yield* runner.resume(name);
          yield* reconcileOne(input.logicalKey, rep, yield* runner.list());
        }).pipe(Effect.mapError(mapError)),
      );
      const status = (yield* Ref.get(statuses)).find(
        (entry) =>
          entry.logicalKey === input.logicalKey && entry.environmentId === input.environmentId,
      );
      if (!status)
        return yield* new ReplicaError({
          reason: "not_found",
          message: "Replica status not found.",
        });
      return status;
    }),
  });
});
export const layer = Layer.effect(ProjectReplicaService, make);
