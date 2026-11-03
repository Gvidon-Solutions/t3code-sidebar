import { MeshProjectDirectory } from "../mesh/MeshProjectDirectory.ts";
import { lookupMeshProject } from "./meshProjectLookup.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { PeerMcpClient } from "../peer/PeerMcpClient.ts";
import { adoptionSides } from "./adoptionModel.ts";
import { normalizeRepresentationPath } from "@t3tools/shared/meshLayout";
import { meshMachineLabel, meshAuthorityOf, conflictWinner } from "@t3tools/shared/meshLayout";
import { forkParked } from "../serverActivation.ts";
import * as NodeUtil from "node:util";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ReplicaPaths from "./ReplicaPaths.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import {
  CommandId,
  ProjectId,
  type MeshLayoutError,
  ReplicaError,
  type ReplicaLiveStatus,
  type ReplicaRefInput,
  type ReplicaAdoptInput,
  type UnmanagedSyncSession,
  type SidebarProjectMount,
  type SidebarWorkspacesConfig,
  type ProjectPlaceInput,
  type ProjectPlaceResult,
  type ProjectMachinesResult,
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
import {
  replicaIgnorePatterns,
  replicaDriver,
  sessionIdentity,
  sessionStatus,
  sshEndpoint,
} from "./replicaModel.ts";

/** A layout write that failed here is a replica storage failure for the caller. */
const asReplicaError = (error: MeshLayoutError) =>
  Effect.fail(new ReplicaError({ reason: "storage", message: error.message, cause: error }));

export class ProjectReplicaService extends Context.Service<
  ProjectReplicaService,
  {
    readonly unmanaged: Effect.Effect<readonly UnmanagedSyncSession[], ReplicaError>;
    readonly adopt: (input: ReplicaAdoptInput) => Effect.Effect<ProjectPlaceResult, ReplicaError>;
    readonly place: (input: ProjectPlaceInput) => Effect.Effect<ProjectPlaceResult, ReplicaError>;
    readonly machines: (project: string) => Effect.Effect<ProjectMachinesResult, ReplicaError>;
    readonly waitForProject: (
      logicalKey: string,
      environmentId: string,
      seconds: number,
    ) => Effect.Effect<SidebarProjectMount | undefined, ReplicaError>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    readonly reconcile: Effect.Effect<void, ReplicaError>;
    readonly status: Effect.Effect<ReadonlyArray<ReplicaLiveStatus>>;
    readonly changes: Stream.Stream<{ readonly replicas: ReadonlyArray<ReplicaLiveStatus> }>;
    readonly retry: (input: ReplicaRefInput) => Effect.Effect<ReplicaLiveStatus, ReplicaError>;
  }
>()("t3/replicas/ProjectReplicaService") {}

const isReplicaError = Schema.is(ReplicaError);

const samePlacement = (left: SidebarProjectMount | undefined, right: SidebarProjectMount) => {
  if (!left) return false;
  const { projectId: _a, pathAllocated: _b, pathValidated: _c, ...a } = left;
  const { projectId: _d, pathAllocated: _e, pathValidated: _f, ...b } = right;
  return NodeUtil.isDeepStrictEqual(a, b);
};
const placementMatches = (config: SidebarWorkspacesConfig, key: string, rep: SidebarProjectMount) =>
  samePlacement(
    config.projectMounts[key]?.find((entry) => entry.environmentId === rep.environmentId),
    rep,
  );

const make = Effect.gen(function* () {
  const mesh = yield* MeshLayoutService;
  const links = yield* Effect.serviceOption(PeerLinks);
  const peers = yield* Effect.serviceOption(PeerMcpClient);
  const directory = yield* Effect.serviceOption(MeshProjectDirectory);
  const paths = yield* ReplicaPaths.ReplicaPaths;
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
  const started = yield* Ref.make(false);
  const placementLock = yield* Semaphore.make(1);
  const reconciliationLock = yield* Semaphore.make(1);
  // Driver status writes must not trigger their own immediate retries.
  const reconciliationInput = (config: SidebarWorkspacesConfig) => ({
    mounts: config.projectMounts,
    machines: config.machines,
    authority: meshAuthorityOf(config),
    observed: Object.fromEntries(
      Object.entries(config.projectMountStatus)
        .map(
          ([key, states]) =>
            [
              key,
              Object.fromEntries(
                Object.entries(states).filter(([environmentId]) => {
                  const rep = config.projectMounts[key]?.find(
                    (rep) => rep.environmentId === environmentId,
                  );
                  return rep && replicaDriver(config, rep) !== mesh.environmentId;
                }),
              ),
            ] as const,
        )
        .filter(([, states]) => Object.keys(states).length > 0),
    ),
  });
  const known = new Map<string, string>();
  const refKey = (logicalKey: string, environmentId: string) => `${logicalKey}\0${environmentId}`;
  const updateLive = Effect.fn("ProjectReplicaService.updateLive")(function* (
    status: ReplicaLiveStatus,
  ) {
    yield* Ref.update(statuses, (all) => [
      ...all.filter(
        (row) =>
          refKey(row.logicalKey, row.environmentId) !==
          refKey(status.logicalKey, status.environmentId),
      ),
      status,
    ]);
    yield* PubSub.publish(updates, { replicas: yield* Ref.get(statuses) });
  });
  const publish = Effect.fn("ProjectReplicaService.publish")(function* (
    status: ReplicaLiveStatus,
    expected?: SidebarProjectMount,
  ) {
    const snapshot = (yield* mesh.read).config;
    if (expected && !placementMatches(snapshot, status.logicalKey, expected)) return;
    const current = snapshot.projectMountStatus[status.logicalKey]?.[status.environmentId];
    const conflictCopies = status.conflictCopies ?? current?.conflictCopies;
    if (
      current?.state !== status.state ||
      current?.message !== status.message ||
      current?.skipped !== status.skipped ||
      !NodeUtil.isDeepStrictEqual(current?.skippedPaths, status.skippedPaths) ||
      current?.conflictCopies?.path !== conflictCopies?.path
    )
      yield* mesh.edit((config) =>
        expected && !placementMatches(config, status.logicalKey, expected)
          ? config
          : {
              ...config,
              projectMountStatus: {
                ...config.projectMountStatus,
                [status.logicalKey]: {
                  ...config.projectMountStatus[status.logicalKey],
                  [status.environmentId]: {
                    state: status.state,
                    conflicts: status.conflicts.length,
                    ...(status.message ? { message: status.message } : {}),
                    ...(status.skipped
                      ? { skipped: status.skipped, skippedPaths: status.skippedPaths ?? [] }
                      : {}),
                    ...(conflictCopies ? { conflictCopies } : {}),
                    updatedAt: status.updatedAt,
                  },
                },
              },
            },
      );
    if (expected && !placementMatches((yield* mesh.read).config, status.logicalKey, expected))
      return;
    yield* updateLive({ ...status, ...(conflictCopies ? { conflictCopies } : {}) });
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
          commandId: CommandId.make(yield* crypto.randomUUIDv4().pipe(Effect.mapError(mapError))),
          projectId: ProjectId.make(yield* crypto.randomUUIDv4().pipe(Effect.mapError(mapError))),
          workspaceRoot: rep.path,
          title: (yield* mesh.read).config.projectTitles[logicalKey] || path.basename(rep.path),
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
    attempt: { rep: SidebarProjectMount },
    sessions: ReadonlyArray<MutagenRunner.MutagenSession>,
  ) {
    let rep = attempt.rep;
    let config = (yield* mesh.read).config;
    if (!placementMatches(config, logicalKey, rep)) return;
    if (rep.environmentId === mesh.environmentId && !rep.pathAllocated && !rep.projectId) {
      const existing = sessions.find(
        (session) =>
          session.name === sessionIdentity(rep.syncKey ?? logicalKey, rep.environmentId).name,
      );
      const allocated = existing
        ? rep.path
        : rep.explicitPath || rep.transport !== "mutagen"
          ? yield* paths.prepareExplicit(rep.path)
          : yield* paths.allocate(rep.path);
      const snapshot = yield* mesh.edit((current) => ({
        ...current,
        projectMounts: {
          ...current.projectMounts,
          [logicalKey]: (current.projectMounts[logicalKey] ?? []).map((entry) =>
            samePlacement(entry, rep) ? { ...entry, path: allocated, pathAllocated: true } : entry,
          ),
        },
      }));
      config = snapshot.config;
      const allocatedRep = config.projectMounts[logicalKey]?.find(
        (entry) => entry.environmentId === rep.environmentId,
      );
      if (!samePlacement(allocatedRep, { ...rep, path: allocated })) return;
      rep = allocatedRep!;
      attempt.rep = rep;
    }
    const publishPlacement = (status: ReplicaLiveStatus) => publish(status, rep);
    if (rep.adoption && !rep.adoption.paused) return;
    const driver = replicaDriver(config, rep);
    const now = DateTime.formatIso(yield* DateTime.now);
    const base = {
      logicalKey,
      environmentId: rep.environmentId,
      conflicts: [],
      problems: [],
      localPath: rep.path,
      ...(rep.projectId ? { projectId: rep.projectId } : {}),
      updatedAt: now,
    } satisfies Omit<ReplicaLiveStatus, "state">;
    if (
      rep.transport !== "mutagen" &&
      rep.pathValidated &&
      rep.environmentId === mesh.environmentId
    ) {
      yield* register(logicalKey, rep);
      yield* publishPlacement({
        ...base,
        state: "watching",
        message: rep.transport === "sshfs" ? "External folder (SSHFS)" : "Manual copy",
      });
      return;
    }
    if (!driver) {
      if (rep.environmentId === mesh.environmentId)
        yield* publishPlacement({
          ...base,
          state: "error",
          message: `${meshMachineLabel(config, rep.environmentId)} cannot reach ${rep.source ? meshMachineLabel(config, rep.source) : "the source"}. Add an SSH route in Settings › Mesh.`,
        });
      return;
    }
    if (driver !== mesh.environmentId) {
      if (
        rep.environmentId === mesh.environmentId &&
        config.projectMountStatus[logicalKey]?.[rep.environmentId]?.state === "watching"
      )
        yield* register(logicalKey, rep);
      if (rep.environmentId === mesh.environmentId) {
        const snapshot = (yield* mesh.read).config;
        const persisted = snapshot.projectMountStatus[logicalKey]?.[rep.environmentId];
        const current = snapshot.projectMounts[logicalKey]?.find(
          (entry) => entry.environmentId === rep.environmentId,
        );
        const status: ReplicaLiveStatus = {
          ...base,
          state: persisted?.state ?? "pending",
          ...(persisted?.message ? { message: persisted.message } : {}),
          ...(persisted?.skipped
            ? { skipped: persisted.skipped, skippedPaths: persisted.skippedPaths ?? [] }
            : {}),
          ...(current?.projectId ? { projectId: current.projectId } : {}),
        };
        if (placementMatches(snapshot, logicalKey, rep)) yield* updateLive(status);
      }
      return;
    }
    if (!rep.pathAllocated && !rep.projectId) return;
    const identity = sessionIdentity(rep.syncKey ?? logicalKey, rep.environmentId);
    const key = refKey(logicalKey, rep.environmentId);
    const matching = sessions.filter(
      (candidate) =>
        candidate.name === identity.name &&
        candidate.labels?.["t3-logical"] === identity.logicalHash &&
        candidate.labels?.["t3-env"] === identity.environmentTag,
    );
    let session = matching[0];
    for (const duplicate of matching.slice(1)) yield* runner.terminate(duplicate.identifier);
    const source = config.projectMounts[logicalKey]?.find(
      (candidate) => candidate.environmentId === rep.source,
    );
    if (!source || source.role !== "primary")
      return yield* new ReplicaError({
        reason: "not_found",
        message: "Replica source representation is missing.",
      });

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
    const createInput = {
      ...identity,
      ignores: replicaIgnorePatterns([...defaults.replicaIgnores, ...(rep.ignores ?? [])]),
      alpha:
        driver === source.environmentId
          ? source.path
          : sshEndpoint(route, source.environmentId, source.path),
      beta:
        driver === rep.environmentId ? rep.path : sshEndpoint(route, rep.environmentId, rep.path),
    };
    if (rep.explicitPath && !rep.pathValidated) {
      yield* runner.assertReplicaPath({
        source: {
          environmentId: source.environmentId,
          path: source.path,
          ...(driver !== source.environmentId ? { route } : {}),
        },
        destination: {
          environmentId: rep.environmentId,
          path: rep.path,
          ...(driver !== rep.environmentId ? { route } : {}),
        },
        ignores: createInput.ignores,
      });
      yield* mesh.edit((current) => ({
        ...current,
        projectMounts: {
          ...current.projectMounts,
          [logicalKey]: (current.projectMounts[logicalKey] ?? []).map((entry) =>
            samePlacement(entry, rep) ? { ...entry, pathValidated: true } : entry,
          ),
        },
      }));
    }
    if (!placementMatches((yield* mesh.read).config, logicalKey, rep)) return;
    if (rep.transport !== "mutagen") {
      yield* register(logicalKey, rep);
      yield* publishPlacement({
        ...base,
        state: "watching",
        message: rep.transport === "sshfs" ? "External folder (SSHFS)" : "Manual copy",
      });
      return;
    }
    const ignoresChanged =
      session !== undefined &&
      !NodeUtil.isDeepStrictEqual(session.ignore?.paths ?? [], createInput.ignores);
    known.set(key, identity.name);
    if (
      session &&
      (session.alpha.path !== source.path ||
        session.beta.path !== rep.path ||
        (ignoresChanged && !session.conflicts?.length))
    ) {
      yield* runner.terminate(session.identifier);
      session = undefined;
    }
    if (!session) {
      yield* publishPlacement({ ...base, sessionName: identity.name, state: "pending" });
      yield* runner.create(createInput);
      yield* publishPlacement({ ...base, sessionName: identity.name, state: "mounting" });
    } else {
      if (session.paused) yield* runner.resume(identity.name);
      const previous = config.projectMountStatus[logicalKey]?.[rep.environmentId];
      const liveState = sessionStatus(session);
      const status = {
        ...base,
        sessionName: identity.name,
        ...liveState,
        ...(previous?.message?.startsWith("Resolved ") && liveState.state !== "error"
          ? {
              message: [previous.message.split(" · ").slice(0, 2).join(" · "), liveState.message]
                .filter(Boolean)
                .join(" · "),
              ...(previous.conflictCopies ? { conflictCopies: previous.conflictCopies } : {}),
            }
          : {}),
      };
      if (status.conflicts.length && status.state !== "error") {
        const loser =
          conflictWinner(config, source.environmentId, rep.environmentId) === "alpha"
            ? rep
            : source;
        const route =
          loser.environmentId === mesh.environmentId
            ? undefined
            : config.machines[mesh.environmentId]?.reach?.[loser.environmentId];
        if (loser.environmentId !== mesh.environmentId && !route)
          return yield* new ReplicaError({
            reason: "unreachable",
            message: "Cannot reach the losing side to preserve conflict copies.",
          });
        yield* runner.pause(identity.name);
        yield* runner.preserveConflicts({
          root: loser.path,
          environmentId: loser.environmentId,
          paths: status.conflicts,
          iso: now,
          ...(route ? { route } : {}),
        });
        if (ignoresChanged || !session.ignore?.paths?.includes(".t3-conflicts")) {
          yield* runner.terminate(identity.name);
          yield* runner.create(createInput);
        } else yield* runner.reset(identity.name);
        yield* runner.resume(identity.name);
        yield* runner.flush(identity.name);
        yield* publishPlacement({
          ...base,
          sessionName: identity.name,
          state: "mounting",
          message: `Resolved ${status.conflicts.length} conflicts automatically · copies in .t3-conflicts`,
          conflictCopies: {
            environmentId: loser.environmentId,
            path: `${loser.path}/.t3-conflicts/${now}/`,
          },
        });
        return;
      }
      if (status.state === "watching") yield* register(logicalKey, rep);
      yield* publishPlacement(status);
    }
  });
  const mapError = (cause: unknown) =>
    isReplicaError(cause)
      ? cause
      : new ReplicaError({ reason: "storage", message: "Replica reconciliation failed.", cause });
  const reconcile = Effect.fn("ProjectReplicaService.reconcile")(function* () {
    if (!(yield* settings.getSettings).replicasEnabled) return;
    const initial = (yield* mesh.read).config;
    for (const [logicalKey, reps] of Object.entries(initial.projectMounts)) {
      for (const rep of reps) {
        const adoption = rep.adoption;
        if (!adoption || adoption.environmentId !== mesh.environmentId) continue;
        yield* Effect.gen(function* () {
          const old = (yield* runner.foreignList).find(
            (session) => session.identifier === adoption.sessionIdentifier,
          );
          let clear = false;
          if (!adoption.paused) {
            if (!old)
              return yield* new ReplicaError({
                reason: "not_found",
                message:
                  "The original sync session disappeared before it could be paused. Its folders are unchanged.",
              });
            yield* runner.foreignAction("pause", old.identifier);
          } else if (
            initial.projectMountStatus[logicalKey]?.[rep.environmentId]?.state === "watching"
          ) {
            if (old) yield* runner.foreignAction("terminate", old.identifier);
            clear = true;
          } else return;
          yield* mesh.edit((current) => ({
            ...current,
            projectMounts: {
              ...current.projectMounts,
              [logicalKey]: (current.projectMounts[logicalKey] ?? []).map((entry) => {
                if (
                  entry.environmentId !== rep.environmentId ||
                  entry.adoption?.sessionIdentifier !== adoption.sessionIdentifier
                )
                  return entry;
                const { adoption: _old, ...rest } = entry;
                return clear ? rest : { ...entry, adoption: { ...adoption, paused: true } };
              }),
            },
          }));
        }).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              yield* publish(
                {
                  logicalKey,
                  environmentId: rep.environmentId,
                  state: "error",
                  conflicts: [],
                  problems: [mapError(cause).message],
                  message: mapError(cause).message,
                  updatedAt: DateTime.formatIso(yield* DateTime.now),
                },
                rep,
              );
            }),
          ),
        );
      }
    }
    const { config, document } = yield* mesh.read;
    const entries = Object.entries(config.projectMounts).flatMap(([logicalKey, reps]) =>
      reps.filter((rep) => rep.role === "replica").map((rep) => ({ logicalKey, rep })),
    );
    const now = DateTime.formatIso(yield* DateTime.now);
    for (const [logicalKey, reps] of Object.entries(config.projectMounts)) {
      const primary = reps.find(
        (rep) => rep.environmentId === mesh.environmentId && rep.role === "primary",
      );
      if (primary?.projectId && !config.projectTitles[logicalKey]) {
        const project = yield* projects.getById(ProjectId.make(primary.projectId));
        if (Option.isSome(project))
          yield* mesh.edit((current) =>
            current.projectTitles[logicalKey]
              ? current
              : {
                  ...current,
                  projectTitles: { ...current.projectTitles, [logicalKey]: project.value.title },
                },
          );
      }
      for (const rep of reps)
        if (rep.environmentId === mesh.environmentId && rep.role === "primary" && !rep.projectId) {
          yield* register(logicalKey, rep).pipe(
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
          );
        }
    }
    yield* syncManagedSshConfig(
      config.machines[mesh.environmentId]?.reach,
      mesh.environmentId,
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.HomeDirectory, home),
    );
    const driven = entries.filter(
      ({ rep }) => rep.transport === "mutagen" && replicaDriver(config, rep) === mesh.environmentId,
    );
    for (const { logicalKey, rep } of entries.filter(
      ({ rep }) => rep.transport !== "mutagen" || replicaDriver(config, rep) !== mesh.environmentId,
    )) {
      const attempt = { rep };
      yield* locks.withLock(
        refKey(logicalKey, rep.environmentId),
        reconcileOne(logicalKey, attempt, []).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              if (!placementMatches((yield* mesh.read).config, logicalKey, attempt.rep)) return;
              yield* updateLive({
                logicalKey,
                environmentId: rep.environmentId,
                state: "error",
                conflicts: [],
                problems: [mapError(cause).message],
                message: mapError(cause).message,
                localPath: attempt.rep.path,
                updatedAt: now,
              });
            }),
          ),
        ),
      );
    }
    for (const { logicalKey, rep } of driven) {
      const attempt = { rep };
      yield* locks.withLock(
        refKey(logicalKey, rep.environmentId),
        Effect.flatMap(runner.list(), (latest) => reconcileOne(logicalKey, attempt, latest)).pipe(
          Effect.catch((cause) =>
            publish(
              {
                logicalKey,
                environmentId: rep.environmentId,
                state: "error",
                conflicts: [],
                problems: [mapError(cause).message],
                message: mapError(cause).message,
                localPath: attempt.rep.path,
                updatedAt: now,
              },
              attempt.rep,
            ),
          ),
        ),
      );
    }
    const sessions = yield* runner.listExisting;
    for (const { logicalKey, rep } of entries) {
      const identity = sessionIdentity(rep.syncKey ?? logicalKey, rep.environmentId);
      if (
        sessions.some(
          (session) =>
            session.name === identity.name &&
            session.labels?.["t3-logical"] === identity.logicalHash &&
            session.labels?.["t3-env"] === identity.environmentTag,
        )
      )
        known.set(refKey(logicalKey, rep.environmentId), identity.name);
    }
    const terminated = new Set<string>();
    // Raw claims also retain sessions removed by authority selection or a role change.
    for (const [key, entry] of Object.entries(document)) {
      if (!key.startsWith("rep/")) continue;
      const [, logicalKey, environmentId] = key.split("/").map(decodeURIComponent);
      let currentKey = logicalKey;
      const visited = new Set<string>();
      while (currentKey && config.projectAliases[currentKey] && !visited.has(currentKey)) {
        visited.add(currentKey);
        currentKey = config.projectAliases[currentKey];
      }
      const active = currentKey
        ? config.projectMounts[currentKey]?.find((rep) => rep.environmentId === environmentId)
        : undefined;
      if (
        !logicalKey ||
        !environmentId ||
        (active?.role === "replica" &&
          active.transport === "mutagen" &&
          replicaDriver(config, active) === mesh.environmentId)
      )
        continue;
      const rawSyncKey =
        entry.v &&
        typeof entry.v === "object" &&
        "syncKey" in entry.v &&
        typeof entry.v.syncKey === "string"
          ? entry.v.syncKey
          : undefined;
      const syncKeys = new Set([
        logicalKey,
        rawSyncKey,
        active?.syncKey,
        ...Object.keys(config.projectAliases).filter(
          (alias) => config.projectAliases[alias] === logicalKey,
        ),
      ]);
      for (const syncKey of syncKeys) {
        if (!syncKey) continue;
        const identity = sessionIdentity(syncKey, environmentId);
        if (
          !terminated.has(identity.name) &&
          sessions.some(
            (session) =>
              session.name === identity.name &&
              session.labels?.["t3-logical"] === identity.logicalHash &&
              session.labels?.["t3-env"] === identity.environmentTag,
          )
        ) {
          yield* locks.withLock(refKey(logicalKey, environmentId), runner.terminate(identity.name));
          terminated.add(identity.name);
          known.delete(refKey(logicalKey, environmentId));
        }
      }
    }
    for (const [key, name] of known)
      if (
        !entries.some(
          ({ logicalKey, rep }) =>
            key === refKey(logicalKey, rep.environmentId) &&
            rep.transport === "mutagen" &&
            replicaDriver(config, rep) === mesh.environmentId,
        )
      ) {
        if (
          entries.some(
            ({ logicalKey, rep }) =>
              rep.transport === "mutagen" &&
              replicaDriver(config, rep) === mesh.environmentId &&
              sessionIdentity(rep.syncKey ?? logicalKey, rep.environmentId).name === name,
          )
        ) {
          known.delete(key);
          continue;
        }
        if (!terminated.has(name) && sessions.some((session) => session.name === name))
          yield* locks.withLock(key, runner.terminate(name));
        terminated.add(name);
        known.delete(key);
        if (!entries.some(({ logicalKey, rep }) => key === refKey(logicalKey, rep.environmentId)))
          yield* Ref.update(statuses, (all) =>
            all.filter((row) => refKey(row.logicalKey, row.environmentId) !== key),
          );
      }
    yield* Ref.update(statuses, (rows) =>
      rows.filter((row) => !terminated.has(row.sessionName ?? "")),
    );
    const expected = new Set(
      entries
        .filter(({ rep }) => rep.transport === "mutagen")
        .map(
          ({ logicalKey, rep }) =>
            sessionIdentity(rep.syncKey ?? logicalKey, rep.environmentId).name,
        ),
    );
    yield* Ref.update(statuses, (rows) =>
      rows.filter(
        (row) =>
          row.logicalKey !== "" ||
          (sessions.some((session) => (session.name ?? session.identifier) === row.sessionName) &&
            !expected.has(row.sessionName ?? "") &&
            !terminated.has(row.sessionName ?? "")),
      ),
    );
    for (const session of sessions) {
      const name = session.name ?? session.identifier;
      if (!expected.has(name) && !terminated.has(name)) {
        yield* Ref.update(statuses, (all) => [
          ...all.filter((row) => row.sessionName !== name),
          {
            logicalKey: "",
            environmentId: mesh.environmentId,
            ...sessionStatus(session),
            sessionName: name,
            message: "Orphan session: no representation; left untouched.",
            updatedAt: now,
          },
        ]);
      }
    }
    yield* PubSub.publish(updates, { replicas: yield* Ref.get(statuses) });
  });
  const reconcileSafely = reconciliationLock.withPermit(
    reconcile().pipe(Effect.mapError(mapError)),
  );
  const readSettings = settings.getSettings.pipe(Effect.mapError(mapError));
  const resolveMachine = (config: SidebarWorkspacesConfig, name: string) => {
    const candidates = [
      ...new Set([
        mesh.environmentId,
        ...Object.keys(config.machines),
        ...Object.values(config.projectMounts).flatMap((reps) =>
          reps.map((rep) => rep.environmentId),
        ),
      ]),
    ];
    if (candidates.includes(name)) return Effect.succeed(name);
    const matches = candidates.filter((id) =>
      [config.machines[id]?.label, config.machines[id]?.tag].some(
        (value) => value?.toLowerCase() === name.toLowerCase(),
      ),
    );
    return matches.length === 1
      ? Effect.succeed(matches[0]!)
      : Effect.fail(
          new ReplicaError({
            reason: "not_found",
            message: matches.length
              ? "Machine name is ambiguous; use its environment id."
              : "Machine was not found in the mesh.",
          }),
        );
  };
  const resolveProjectOnce = Effect.fn("ProjectReplicaService.resolveProjectOnce")(function* (
    name: string,
  ) {
    const config = (yield* mesh.read).config;
    const visited = new Set<string>();
    while (config.projectAliases[name] && !visited.has(name)) {
      visited.add(name);
      name = config.projectAliases[name]!;
    }
    if (config.projectMounts[name]?.length) return { logicalKey: name, config, project: undefined };
    const titled = Object.entries(config.projectTitles ?? {}).filter(
      ([id, title]) =>
        config.projectMounts[id]?.length && title.toLowerCase() === name.toLowerCase(),
    );
    if (titled.length === 1) return { logicalKey: titled[0]![0], config, project: undefined };
    if (titled.length > 1)
      return yield* new ReplicaError({
        reason: "not_found",
        message: "Project name is ambiguous; use its id.",
      });
    const snapshot = yield* projects.snapshot.pipe(Effect.mapError(mapError));
    const found = yield* lookupMeshProject(
      config,
      config.projectTitles[name] || name,
      mesh.environmentId,
      snapshot.projects,
      Option.isSome(links) && Option.isSome(peers)
        ? { links: links.value, peers: peers.value }
        : undefined,
      Option.isSome(directory) ? yield* directory.value.read : [],
    );
    const logicalKey = found.logicalKey;
    const representations = [...(config.projectMounts[logicalKey] ?? [])];
    for (const record of found.records) {
      if (!representations.some((rep) => rep.environmentId === record.environmentId))
        representations.push({
          environmentId: record.environmentId,
          path: record.project.workspaceRoot,
          projectId: record.project.id,
          role: "primary",
          transport: "git",
          createdAt: record.project.createdAt,
        });
    }
    const local = found.records.find((record) => record.environmentId === mesh.environmentId);
    return {
      logicalKey,
      config: {
        ...config,
        projectTitles: {
          ...config.projectTitles,
          [logicalKey]:
            config.projectTitles[logicalKey] ||
            found.records[0]?.project.title ||
            "Untitled project",
        },
        projectMounts: { ...config.projectMounts, [logicalKey]: representations },
      },
      project: local?.project,
    };
  });
  const resolveProject = Effect.fn("ProjectReplicaService.resolveProject")(function* (
    name: string,
  ) {
    if (Option.isNone(directory)) return yield* resolveProjectOnce(name);
    const catalog = directory.value;
    return yield* resolveProjectOnce(name).pipe(
      Effect.catchIf(
        (error) => error.reason === "not_found" || error.reason === "unreachable",
        () =>
          Effect.gen(function* () {
            const result = yield* Stream.merge(
              catalog.changes.pipe(Stream.map(() => undefined)),
              mesh.changes.pipe(Stream.map(() => undefined)),
            ).pipe(
              Stream.mapEffect(() =>
                resolveProjectOnce(name).pipe(
                  Effect.asSome,
                  Effect.catch((cause) =>
                    Effect.logDebug("Waiting for the mesh project catalog", {
                      message: cause.message,
                    }).pipe(Effect.as(Option.none())),
                  ),
                ),
              ),
              Stream.filter(Option.isSome),
              Stream.map((value) => value.value),
              Stream.take(1),
              Stream.runHead,
              Effect.scoped,
              Effect.timeoutOption("20 seconds"),
            );
            const found = Option.flatten(result);
            return Option.isSome(found) ? found.value : yield* resolveProjectOnce(name);
          }),
      ),
    );
  });
  const waitForProject = Effect.fn("ProjectReplicaService.waitForProject")(function* (
    logicalKey: string,
    environmentId: string,
    seconds: number,
  ) {
    const result = yield* mesh.changes.pipe(
      Stream.mapEffect((snapshot) => {
        const rep = snapshot.config.projectMounts[logicalKey]?.find(
          (entry) => entry.environmentId === environmentId,
        );
        const state = snapshot.config.projectMountStatus[logicalKey]?.[environmentId];
        if (!rep)
          return Effect.fail(
            new ReplicaError({
              reason: "not_found",
              message: "The representation was removed while waiting.",
            }),
          );
        if (state?.state === "error" || state?.state === "conflict")
          return Effect.fail(
            new ReplicaError({
              reason: "mutagen",
              message:
                state.message ?? `Replica is ${state.state}. Retry after resolving its problems.`,
            }),
          );
        return Effect.succeed(
          rep.projectId && (rep.role === "primary" || state?.state === "watching")
            ? rep
            : undefined,
        );
      }),
      Stream.filter((rep): rep is SidebarProjectMount => rep !== undefined),
      Stream.take(1),
      Stream.runHead,
      Effect.timeoutOption(`${Math.min(600, Math.max(0, seconds))} seconds`),
    );
    return Option.isSome(result) ? Option.getOrUndefined(result.value) : undefined;
  });
  const place = Effect.fn("ProjectReplicaService.place")(function* (input: ProjectPlaceInput) {
    const replicaSettings = yield* readSettings;
    if (!replicaSettings.replicasEnabled)
      return yield* new ReplicaError({ reason: "disabled", message: "Replicas are disabled." });
    const resolved = yield* resolveProject(input.project);
    const yieldDate = yield* DateTime.now;
    const environmentId = yield* resolveMachine(resolved.config, input.machine);
    return yield* placementLock.withPermit(
      Effect.gen(function* () {
        let config = (yield* mesh.read).config;
        const logicalKey = resolved.logicalKey;
        const resolvedTitle = resolved.config.projectTitles[logicalKey] || resolved.project?.title;
        if (!config.projectTitles[logicalKey] && resolvedTitle) {
          config = (yield* mesh.edit((current) => ({
            ...current,
            projectTitles: { ...current.projectTitles, [logicalKey]: resolvedTitle },
          }))).config;
        }
        if (input.action === "remove") {
          yield* mesh.edit((current) => {
            const projectMounts = { ...current.projectMounts };
            const reps = (projectMounts[logicalKey] ?? []).filter(
              (rep) => rep.environmentId !== environmentId,
            );
            if (reps.length) projectMounts[logicalKey] = reps;
            else delete projectMounts[logicalKey];
            const projectMountStatus = { ...current.projectMountStatus };
            const states = { ...projectMountStatus[logicalKey] };
            delete states[environmentId];
            if (Object.keys(states).length) projectMountStatus[logicalKey] = states;
            else delete projectMountStatus[logicalKey];
            return { ...current, projectMounts, projectMountStatus };
          });
          return { logicalKey, representation: null, ready: true };
        }
        const discovered = (resolved.config.projectMounts[logicalKey] ?? []).filter(
          (rep) =>
            !(config.projectMounts[logicalKey] ?? []).some(
              (current) => current.environmentId === rep.environmentId,
            ),
        );
        if (discovered.length)
          config = (yield* mesh.edit((current) => ({
            ...current,
            projectMounts: {
              ...current.projectMounts,
              [logicalKey]: [
                ...(current.projectMounts[logicalKey] ?? []),
                ...discovered.filter(
                  (rep) =>
                    !(current.projectMounts[logicalKey] ?? []).some(
                      (known) => known.environmentId === rep.environmentId,
                    ),
                ),
              ],
            },
          }))).config;
        let rep = config.projectMounts[logicalKey]?.find(
          (entry) => entry.environmentId === environmentId,
        );
        if (
          !rep ||
          (input.role && rep.role !== input.role) ||
          input.path !== undefined ||
          input.transport !== undefined ||
          input.ignores !== undefined
        ) {
          const sourceId = input.source
            ? yield* resolveMachine(config, input.source)
            : config.projectMounts[logicalKey]?.find((entry) => entry.role === "primary")
                ?.environmentId;
          const source = config.projectMounts[logicalKey]?.find(
            (entry) => entry.environmentId === sourceId,
          );
          if (!source || source.role !== "primary")
            return yield* new ReplicaError({
              reason: "not_found",
              message: "A source primary representation is required.",
            });
          const role = input.role ?? rep?.role ?? "replica";
          if (role === "replica" && source.environmentId === environmentId)
            return yield* new ReplicaError({
              reason: "unreachable",
              message: "A replica cannot use itself as its source.",
            });
          if (role === "primary" && !input.path && !rep)
            return yield* new ReplicaError({
              reason: "storage",
              message: "Pass the existing checkout path when adding a primary.",
            });
          const transport =
            role === "primary" ? "git" : (input.transport ?? rep?.transport ?? "mutagen");
          if (transport !== "git" && transport !== "mutagen" && !input.path && !rep)
            return yield* new ReplicaError({
              reason: "storage",
              message:
                "Choose the existing external folder using --path for manual or SSHFS copies.",
            });
          const root = input.path ?? rep?.path ?? source.path;
          const changedPath = rep?.path !== root;
          const explicitPath = input.path !== undefined || rep?.explicitPath === true;
          if (
            Object.entries(config.projectMounts).some(
              ([key, reps]) =>
                key !== logicalKey &&
                reps.some(
                  (entry) =>
                    entry.environmentId === environmentId &&
                    normalizeRepresentationPath(entry.path) === normalizeRepresentationPath(root),
                ),
            )
          )
            return yield* new ReplicaError({
              reason: "storage",
              message:
                "The requested folder belongs to another project. Choose another folder or merge the projects.",
            });
          let projectId = changedPath ? undefined : rep?.projectId;
          let allocated = changedPath ? false : (rep?.pathAllocated ?? false);
          let destination = root;
          let validated = !changedPath && (rep?.pathValidated ?? Boolean(rep?.projectId));
          if (environmentId === mesh.environmentId) {
            if (role === "replica" && (changedPath || !allocated)) {
              destination = explicitPath
                ? yield* paths.prepareExplicit(root)
                : yield* paths.allocate(root);
              allocated = true;
            }
            if (role === "replica" && explicitPath && !validated) {
              const sourceRoute =
                config.machines[mesh.environmentId]?.reach?.[source.environmentId];
              if (sourceRoute) {
                yield* runner.assertReplicaPath({
                  source: {
                    path: source.path,
                    environmentId: source.environmentId,
                    route: sourceRoute,
                  },
                  destination: { path: destination, environmentId },
                  ignores: [
                    ...replicaSettings.replicaIgnores,
                    ...(input.ignores ?? rep?.ignores ?? []),
                  ],
                });
                validated = true;
              }
            }
            if (role === "primary") {
              const existing = yield* projects
                .getByWorkspaceRoot(root)
                .pipe(Effect.mapError(mapError));
              if (Option.isSome(existing)) projectId = existing.value.id;
              else
                projectId = (yield* projects
                  .create({
                    commandId: CommandId.make(
                      yield* crypto.randomUUIDv4().pipe(Effect.mapError(mapError)),
                    ),
                    projectId: ProjectId.make(
                      yield* crypto.randomUUIDv4().pipe(Effect.mapError(mapError)),
                    ),
                    workspaceRoot: root,
                    title: path.basename(root),
                  })
                  .pipe(Effect.mapError(mapError))).id;
            }
          }
          rep = {
            environmentId,
            path: destination,
            pathAllocated: allocated,
            ...(projectId ? { projectId } : {}),
            role,
            transport,
            ...(rep?.syncKey ? { syncKey: rep.syncKey } : {}),
            ...(explicitPath ? { explicitPath: true, pathValidated: validated } : {}),
            ...(input.ignores !== undefined || rep?.ignores
              ? { ignores: input.ignores ?? rep?.ignores ?? [] }
              : {}),
            ...(role === "replica" ? { source: source.environmentId } : {}),
            createdAt: DateTime.formatIso(yieldDate),
          };
          const created = rep;
          config = (yield* mesh.edit((current) => ({
            ...current,
            projectMountStatus: {
              ...current.projectMountStatus,
              [logicalKey]: {
                ...current.projectMountStatus[logicalKey],
                [environmentId]: {
                  state: role === "primary" ? "watching" : "pending",
                  updatedAt: DateTime.formatIso(yieldDate),
                  ...(current.projectMountStatus[logicalKey]?.[environmentId]?.conflictCopies
                    ? {
                        conflictCopies:
                          current.projectMountStatus[logicalKey]![environmentId]!.conflictCopies,
                      }
                    : {}),
                },
              },
            },
            projectMounts: {
              ...current.projectMounts,
              [logicalKey]: [
                ...(current.projectMounts[logicalKey] ?? []).filter(
                  (entry) => entry.environmentId !== environmentId,
                ),
                created,
              ],
            },
          }))).config;
        }
        return {
          logicalKey,
          representation: rep ?? null,
          ready: Boolean(
            rep?.projectId &&
            (rep.role === "primary" ||
              config.projectMountStatus[logicalKey]?.[environmentId]?.state === "watching"),
          ),
        };
      }),
    );
  });

  return ProjectReplicaService.of({
    unmanaged: runner.foreignList.pipe(
      Effect.map((sessions) =>
        sessions
          .filter((session) => !session.labels?.["t3-logical"])
          .map((session) => ({
            identifier: session.identifier,
            ...(session.name ? { name: session.name } : {}),
            alpha: session.alpha,
            beta: session.beta,
            ignores: session.ignore?.paths ?? [],
          })),
      ),
    ),
    adopt: Effect.fn("ProjectReplicaService.adopt")((input) =>
      reconciliationLock.withPermit(
        placementLock
          .withPermit(
            Effect.gen(function* () {
              if (!(yield* readSettings).replicasEnabled)
                return yield* new ReplicaError({
                  reason: "disabled",
                  message: "Replicas are disabled.",
                });
              const resolved = yield* resolveProject(input.project);
              const { config, logicalKey } = resolved;
              const sessions = yield* runner.foreignList;
              const matches = sessions.filter(
                (session) => session.identifier === input.session || session.name === input.session,
              );
              if (matches.length !== 1)
                return yield* new ReplicaError({
                  reason: "not_found",
                  message: "Choose one existing Mutagen session by its name.",
                });
              const session = matches[0]!;
              const reps = config.projectMounts[logicalKey] ?? [];
              const primary: SidebarProjectMount | undefined = resolved.project
                ? {
                    environmentId: mesh.environmentId,
                    path: resolved.project.workspaceRoot,
                    projectId: resolved.project.id,
                    role: "primary",
                    transport: "git",
                    createdAt: "",
                  }
                : undefined;
              const allReps = reps.length ? reps : primary ? [primary] : [];
              const target = input.machine
                ? yield* resolveMachine(config, input.machine)
                : undefined;
              const sides = adoptionSides(config, mesh.environmentId, allReps, session, target);
              if (!sides)
                return yield* new ReplicaError({
                  reason: "unreachable",
                  message:
                    "This session must connect a primary folder of this project to another linked machine. Add its SSH route in Settings › Mesh, or choose the destination machine.",
                });
              for (const [other, mounts] of Object.entries(config.projectMounts))
                if (
                  other !== logicalKey &&
                  mounts.some(
                    (rep) =>
                      rep.environmentId === sides.machine &&
                      normalizeRepresentationPath(rep.path) ===
                        normalizeRepresentationPath(sides.destination.path),
                  )
                )
                  return yield* new ReplicaError({
                    reason: "storage",
                    message: "This folder already belongs to another project.",
                  });
              const existing = allReps.find((rep) => rep.environmentId === sides.machine);
              if (existing?.adoption?.sessionIdentifier === session.identifier)
                return { logicalKey, representation: existing, ready: false };
              if (existing?.adoption)
                return yield* new ReplicaError({
                  reason: "storage",
                  message: "Another sync session is already being adopted for this copy.",
                });
              const representation: SidebarProjectMount = {
                environmentId: sides.machine,
                path: sides.destination.path,
                role: "replica",
                transport: "mutagen",
                source: sides.source.environmentId,
                ...(existing?.path === sides.destination.path && existing.projectId
                  ? { projectId: existing.projectId }
                  : {}),
                pathAllocated: true,
                explicitPath: true,
                pathValidated: true,
                ignores: session.ignore?.paths ?? [],
                createdAt: DateTime.formatIso(yield* DateTime.now),
                adoption: {
                  environmentId: mesh.environmentId,
                  sessionIdentifier: session.identifier,
                  paused: false,
                },
              };
              yield* mesh.edit((current) => ({
                ...current,
                projectTitles: {
                  ...current.projectTitles,
                  ...(!current.projectTitles[logicalKey] && resolved.project
                    ? { [logicalKey]: resolved.project.title }
                    : {}),
                },
                projectMounts: {
                  ...current.projectMounts,
                  [logicalKey]: [
                    ...allReps.filter((rep) => rep.environmentId !== sides.machine),
                    representation,
                  ],
                },
                projectMountStatus: {
                  ...current.projectMountStatus,
                  [logicalKey]: {
                    ...current.projectMountStatus[logicalKey],
                    [sides.machine]: {
                      state: "pending",
                      updatedAt: "",
                      message: "Taking over existing sync…",
                    },
                  },
                },
              }));
              return { logicalKey, representation, ready: false };
            }),
          )
          .pipe(Effect.catchTags({ MeshLayoutError: asReplicaError })),
      ),
    ),
    place: Effect.fn("ProjectReplicaService.placeAndWait")(
      function* (input) {
        const result = yield* place(input);
        if (!result.representation || !input.wait || result.ready) return result;
        const ready = yield* waitForProject(
          result.logicalKey,
          result.representation.environmentId,
          input.wait,
        );
        return ready ? { ...result, representation: ready, ready: true } : result;
      },
      Effect.catchTags({ MeshLayoutError: asReplicaError }),
    ),
    waitForProject,
    machines: Effect.fn("ProjectReplicaService.machines")(function* (project) {
      const { logicalKey, config, project: localProject } = yield* resolveProject(project);
      const live = yield* Ref.get(statuses);
      return {
        logicalKey,
        title: config.projectTitles[logicalKey] || localProject?.title || "Untitled project",
        ...(meshAuthorityOf(config) ? { authorityEnvironmentId: meshAuthorityOf(config)! } : {}),
        representations: (config.projectMounts[logicalKey] ?? []).map((rep) => {
          const status = config.projectMountStatus[logicalKey]?.[rep.environmentId];
          const current = live.find(
            (row) => row.logicalKey === logicalKey && row.environmentId === rep.environmentId,
          );
          const machine = config.machines[rep.environmentId];
          const driver = replicaDriver(config, rep);
          return {
            ...rep,
            machine: machine?.label ?? machine?.tag ?? "Unknown machine",
            ...(machine?.tag ? { tag: machine.tag } : {}),
            ...(driver ? { driverEnvironmentId: driver } : {}),
            ...(status ? { status } : {}),
            ...(current ? { live: current } : {}),
          };
        }),
      };
    }),
    reconcile: reconcileSafely,
    start: Effect.gen(function* () {
      if (yield* Ref.getAndSet(started, true)) return;
      yield* forkParked(
        Stream.merge(
          mesh.changes.pipe(
            Stream.map(({ config }) => reconciliationInput(config)),
            Stream.changesWith(NodeUtil.isDeepStrictEqual),
            Stream.map(() => undefined),
          ),
          Stream.tick("30 seconds").pipe(Stream.drop(1)),
        ).pipe(
          Stream.runForEach(() =>
            reconcileSafely.pipe(
              Effect.catch((error) => Effect.logError("Replica reconciliation failed", { error })),
            ),
          ),
        ),
      );
    }),
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
      const name = sessionIdentity(rep.syncKey ?? input.logicalKey, input.environmentId).name;
      yield* locks.withLock(
        refKey(input.logicalKey, input.environmentId),
        Effect.gen(function* () {
          const sessions = yield* runner.list();
          if (sessions.some((session) => session.name === name)) yield* runner.resume(name);
          yield* reconcileOne(input.logicalKey, { rep }, yield* runner.list());
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
