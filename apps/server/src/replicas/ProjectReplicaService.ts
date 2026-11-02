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
import { replicaDriver, sessionIdentity, sessionStatus, sshEndpoint } from "./replicaModel.ts";

/** A layout write that failed here is a replica storage failure for the caller. */
const asReplicaError = (error: MeshLayoutError) =>
  Effect.fail(new ReplicaError({ reason: "storage", message: error.message, cause: error }));

export class ProjectReplicaService extends Context.Service<
  ProjectReplicaService,
  {
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

const make = Effect.gen(function* () {
  const mesh = yield* MeshLayoutService;
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
  const publish = Effect.fn("ProjectReplicaService.publish")(function* (status: ReplicaLiveStatus) {
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
    yield* updateLive(status);
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
    let config = (yield* mesh.read).config;
    if (rep.environmentId === mesh.environmentId && !rep.pathAllocated && !rep.projectId) {
      const existing = sessions.find(
        (session) => session.name === sessionIdentity(logicalKey, rep.environmentId).name,
      );
      const allocated = existing ? rep.path : yield* paths.allocate(rep.path);
      const snapshot = yield* mesh.edit((current) => ({
        ...current,
        projectMounts: {
          ...current.projectMounts,
          [logicalKey]: (current.projectMounts[logicalKey] ?? []).map((entry) =>
            entry.environmentId === rep.environmentId
              ? { ...entry, path: allocated, pathAllocated: true }
              : entry,
          ),
        },
      }));
      config = snapshot.config;
      rep = config.projectMounts[logicalKey]!.find(
        (entry) => entry.environmentId === rep.environmentId,
      )!;
    }
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
          ...(current?.projectId ? { projectId: current.projectId } : {}),
        };
        yield* updateLive(status);
      }
      return;
    }
    if (!rep.pathAllocated && !rep.projectId) return;
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
      if (status.state === "watching") yield* register(logicalKey, rep);
      yield* publish(status);
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
    for (const [logicalKey, reps] of Object.entries(config.projectMounts)) {
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
    yield* syncManagedSshConfig(config.machines[mesh.environmentId]?.reach).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.HomeDirectory, home),
    );
    const driven = entries.filter(({ rep }) => replicaDriver(config, rep) === mesh.environmentId);
    for (const { logicalKey, rep } of entries.filter(
      ({ rep }) => replicaDriver(config, rep) !== mesh.environmentId,
    )) {
      yield* locks.withLock(
        refKey(logicalKey, rep.environmentId),
        reconcileOne(logicalKey, rep, []).pipe(
          Effect.catch((cause) =>
            updateLive({
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
    const sessions = yield* driven.length > 0 ? runner.list() : runner.listExisting;
    for (const { logicalKey, rep } of driven) {
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
    for (const { logicalKey, rep } of entries) {
      const identity = sessionIdentity(logicalKey, rep.environmentId);
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
        terminated.add(name);
        known.delete(key);
        if (!entries.some(({ logicalKey, rep }) => key === refKey(logicalKey, rep.environmentId)))
          yield* Ref.update(statuses, (all) =>
            all.filter((row) => refKey(row.logicalKey, row.environmentId) !== key),
          );
      }
    const expected = new Set(
      entries.map(({ logicalKey, rep }) => sessionIdentity(logicalKey, rep.environmentId).name),
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
  const reconcileSafely = reconciliationLock
    .withPermit(
      reconcile().pipe(
        Effect.mapError(mapError),
        Effect.tapError((error) =>
          Effect.gen(function* () {
            const { config } = yield* mesh.read;
            const updatedAt = DateTime.formatIso(yield* DateTime.now);
            for (const [logicalKey, reps] of Object.entries(config.projectMounts)) {
              for (const rep of reps)
                if (
                  rep.role === "replica" &&
                  rep.transport === "mutagen" &&
                  replicaDriver(config, rep) === mesh.environmentId
                ) {
                  yield* publish({
                    logicalKey,
                    environmentId: rep.environmentId,
                    state: "error",
                    conflicts: [],
                    problems: [error.message],
                    message: error.message,
                    updatedAt,
                  });
                }
            }
          }),
        ),
      ),
    )
    .pipe(Effect.catchTags({ MeshLayoutError: asReplicaError }));
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
  const resolveProject = Effect.fn("ProjectReplicaService.resolveProject")(function* (
    name: string,
  ) {
    const config = (yield* mesh.read).config;
    if (config.projectMounts[name]) return { logicalKey: name, config };
    const snapshot = yield* projects.snapshot.pipe(Effect.mapError(mapError));
    const matches = snapshot.projects.filter(
      (project) => project.id === name || project.title.toLowerCase() === name.toLowerCase(),
    );
    if (matches.length !== 1)
      return yield* new ReplicaError({
        reason: "not_found",
        message: matches.length
          ? "Project name is ambiguous; use its id or logical key."
          : "Project was not found.",
      });
    const project = matches[0]!;
    const existingKey = Object.keys(config.projectMounts).find((key) =>
      config.projectMounts[key]!.some(
        (rep) =>
          rep.environmentId === mesh.environmentId &&
          (rep.projectId === project.id || rep.path === project.workspaceRoot),
      ),
    );
    const logicalKey = existingKey ?? `${mesh.environmentId}:${project.workspaceRoot}`;
    return { logicalKey, config, project };
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
    if (!(yield* readSettings).replicasEnabled)
      return yield* new ReplicaError({ reason: "disabled", message: "Replicas are disabled." });
    const resolved = yield* resolveProject(input.project);
    const yieldDate = yield* DateTime.now;
    const environmentId = yield* resolveMachine(resolved.config, input.machine);
    return yield* placementLock.withPermit(
      Effect.gen(function* () {
        let config = (yield* mesh.read).config;
        const logicalKey = resolved.logicalKey;
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
        if (!config.projectMounts[logicalKey] && resolved.project) {
          const project = resolved.project;
          config = (yield* mesh.edit((current) => ({
            ...current,
            projectMounts: {
              ...current.projectMounts,
              [logicalKey]: [
                {
                  environmentId: mesh.environmentId,
                  path: project.workspaceRoot,
                  projectId: project.id,
                  role: "primary",
                  transport: "git",
                  createdAt: DateTime.formatIso(yieldDate),
                },
              ],
            },
          }))).config;
        }
        let rep = config.projectMounts[logicalKey]?.find(
          (entry) => entry.environmentId === environmentId,
        );
        if (!rep || (input.role && rep.role !== input.role)) {
          const sourceId = input.source
            ? yield* resolveMachine(config, input.source)
            : config.projectMounts[logicalKey]?.find((entry) => entry.role === "primary")
                ?.environmentId;
          const source = config.projectMounts[logicalKey]?.find(
            (entry) => entry.environmentId === sourceId,
          );
          if (!source)
            return yield* new ReplicaError({
              reason: "not_found",
              message: "A source primary representation is required.",
            });
          const role = input.role ?? "replica";
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
          const root = rep?.path ?? input.path ?? source.path;
          let projectId = rep?.projectId;
          let allocated = rep?.pathAllocated ?? false;
          let destination = root;
          if (environmentId === mesh.environmentId) {
            if (role === "replica" && !rep) {
              destination = yield* paths.allocate(root);
              allocated = true;
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
            transport: role === "primary" ? "git" : "mutagen",
            ...(role === "replica" ? { source: source.environmentId } : {}),
            createdAt: DateTime.formatIso(yieldDate),
          };
          const created = rep;
          yield* mesh.edit((current) => ({
            ...current,
            projectMounts: {
              ...current.projectMounts,
              [logicalKey]: [
                ...(current.projectMounts[logicalKey] ?? []).filter(
                  (entry) => entry.environmentId !== environmentId,
                ),
                created,
              ],
            },
          }));
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
      const { logicalKey, config } = yield* resolveProject(project);
      const live = yield* Ref.get(statuses);
      return {
        logicalKey,
        representations: (config.projectMounts[logicalKey] ?? []).map((rep) => {
          const status = config.projectMountStatus[logicalKey]?.[rep.environmentId];
          const current = live.find(
            (row) => row.logicalKey === logicalKey && row.environmentId === rep.environmentId,
          );
          const machine = config.machines[rep.environmentId];
          const driver = replicaDriver(config, rep);
          return {
            ...rep,
            machine: machine?.label ?? rep.environmentId,
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
