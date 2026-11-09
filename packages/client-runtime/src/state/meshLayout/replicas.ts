import type {
  ReplicaLiveStatus,
  SidebarProjectMount,
  SidebarProjectMountStatus,
  SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { MESH_WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../../connection/registry.ts";
import { machineDisplayOf } from "../machineDisplay.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../runtime.ts";
import { addRepresentation } from "./logicalProjects.ts";

// Mesh replicas (fork feature): the pure plan a client shows and acts on while a project is
// being mounted on another machine, plus the live-status merge across connected servers.

export type ReplicaPlan =
  | { readonly kind: "ready"; readonly rep: SidebarProjectMount; readonly projectId: string }
  | { readonly kind: "create"; readonly rep: SidebarProjectMount }
  | {
      readonly kind: "pending";
      readonly rep: SidebarProjectMount;
      readonly status: SidebarProjectMountStatus | null;
    };

export interface ThreadOnMachinePlan {
  readonly kind: ReplicaPlan["kind"];
  /** The config with the primary seed and/or the replica representation applied. */
  readonly config: SidebarWorkspacesConfig;
  readonly rep: SidebarProjectMount;
  readonly status: SidebarProjectMountStatus | null;
  readonly projectId: string | null;
}

/** The relation a new project representation starts from: its first existing representation. */
function sourceRepresentation(
  reps: ReadonlyArray<SidebarProjectMount>,
): SidebarProjectMount | null {
  return (
    reps.find((rep) => rep.role === "primary") ??
    reps.find((rep) => rep.projectId !== undefined) ??
    reps[0] ??
    null
  );
}

/**
 * What "new thread in this logical project on `targetEnvironmentId`" needs: an existing
 * project there ("ready"), a replica entry to write ("create"), or a wait for the server to
 * register the project ("pending").
 *
 * `createdAt` is passed by the caller so this stays pure; `""` is the schema default.
 */
function replicaPlan(
  config: SidebarWorkspacesConfig,
  logicalKey: string,
  targetEnvironmentId: string,
  createdAt = "",
): ReplicaPlan {
  const reps = config.projectMounts[logicalKey] ?? [];
  const existing = reps.find((rep) => rep.environmentId === targetEnvironmentId);
  if (existing?.projectId !== undefined) {
    return { kind: "ready", rep: existing, projectId: existing.projectId };
  }
  if (existing) {
    return {
      kind: "pending",
      rep: existing,
      status: config.projectMountStatus[logicalKey]?.[targetEnvironmentId] ?? null,
    };
  }
  const source = sourceRepresentation(reps);
  return {
    kind: "create",
    rep: {
      environmentId: targetEnvironmentId,
      // The server uses the same absolute path when it is free; the source's path is the
      // representation's path either way.
      path: source?.path ?? "",
      transport: "mutagen",
      role: "replica",
      ...(source ? { source: source.environmentId } : {}),
      createdAt,
    },
  };
}

/**
 * Plans a thread on `targetEnvironmentId` and returns the config to write. A logical project
 * with no representations (a pre-mesh folder) first records the folder's own project as its
 * primary.
 */
export function planThreadOnMachine(input: {
  readonly config: SidebarWorkspacesConfig;
  readonly logicalKey: string;
  readonly targetEnvironmentId: string;
  readonly seed?: {
    readonly environmentId: string;
    readonly path: string;
    readonly projectId: string;
  } | null;
  readonly createdAt?: string;
}): ThreadOnMachinePlan {
  const { logicalKey, targetEnvironmentId } = input;
  const createdAt = input.createdAt ?? "";
  let config = input.config;
  const reps = config.projectMounts[logicalKey] ?? [];
  if (reps.length === 0 && input.seed) {
    config = addRepresentation(config, logicalKey, {
      environmentId: input.seed.environmentId,
      path: input.seed.path,
      projectId: input.seed.projectId,
      transport: "git",
      role: "primary",
      createdAt,
    });
  }
  const plan = replicaPlan(config, logicalKey, targetEnvironmentId, createdAt);
  if (plan.kind === "create") config = addRepresentation(config, logicalKey, plan.rep);
  return {
    kind: plan.kind,
    config,
    rep: plan.rep,
    status: plan.kind === "pending" ? plan.status : null,
    projectId: plan.kind === "ready" ? plan.projectId : null,
  };
}

/** The environment whose server drives (or holds) a replica's Mutagen session. */
export function replicaDriverEnvironment(
  _config: SidebarWorkspacesConfig,
  rep: SidebarProjectMount,
): string | null {
  return rep.role === "replica" && rep.source ? rep.environmentId : null;
}

export interface PendingReplicaRow {
  readonly logicalKey: string;
  readonly rep: SidebarProjectMount;
  readonly status: SidebarProjectMountStatus;
  readonly live: ReplicaLiveStatus | null;
  /** 0..1 while the first sync stages, when the machine reports it. */
  readonly progress: number | null;
  readonly conflicts: number;
  readonly message: string | null;
  /** The project id the machine registered, possibly one push before the layout carries it. */
  readonly projectId: string | null;
}

const PENDING_STATUS: SidebarProjectMountStatus = { state: "pending", updatedAt: "" };

/**
 * Unregistered copies and synchronization failures stay visible in their folder.
 */
export function pendingRows(
  config: SidebarWorkspacesConfig,
  liveStatuses: ReadonlyArray<ReplicaLiveStatus>,
): PendingReplicaRow[] {
  const live = new Map<string, ReplicaLiveStatus>();
  for (const status of liveStatuses) {
    live.set(`${status.logicalKey}\0${status.environmentId}`, status);
  }
  const rows: PendingReplicaRow[] = [];
  for (const [logicalKey, reps] of Object.entries(config.projectMounts)) {
    for (const rep of reps) {
      if (rep.role === "primary" && rep.transport === "git" && rep.projectId !== undefined)
        continue;
      const liveStatus = live.get(`${logicalKey}\0${rep.environmentId}`) ?? null;
      const stored = config.projectMountStatus[logicalKey]?.[rep.environmentId];
      const status: SidebarProjectMountStatus = liveStatus
        ? {
            state: liveStatus.state,
            conflicts: liveStatus.conflicts.length,
            ...(liveStatus.message ? { message: liveStatus.message } : {}),
            ...(liveStatus.skipped
              ? { skipped: liveStatus.skipped, skippedPaths: liveStatus.skippedPaths ?? [] }
              : {}),
            updatedAt: liveStatus.updatedAt,
          }
        : (stored ?? PENDING_STATUS);
      if (rep.projectId !== undefined && status.state !== "conflict" && status.state !== "error")
        continue;
      rows.push({
        logicalKey,
        rep,
        status,
        live: liveStatus,
        progress: liveStatus?.progress ?? null,
        conflicts: liveStatus ? liveStatus.conflicts.length : (stored?.conflicts ?? 0),
        message: liveStatus ? (liveStatus.message ?? null) : (stored?.message ?? null),
        projectId: rep.projectId ?? liveStatus?.projectId ?? null,
      });
    }
  }
  return rows.sort(
    (left, right) =>
      left.logicalKey.localeCompare(right.logicalKey) ||
      left.rep.environmentId.localeCompare(right.rep.environmentId),
  );
}

export interface RepresentationRow {
  readonly rep: SidebarProjectMount;
  readonly status: SidebarProjectMountStatus;
  readonly text: string;
  /** Set when the machine wants a retry for this representation. */
  readonly retry: PendingReplicaRow | null;
}

/** The line and retry action for one representation, registered or still mounting. */
export function representationRow(
  config: SidebarWorkspacesConfig,
  liveStatuses: ReadonlyArray<ReplicaLiveStatus>,
  logicalKey: string,
  rep: SidebarProjectMount,
): RepresentationRow {
  const machine = machineDisplayOf(config, rep.environmentId, rep.environmentId);
  const source = rep.source ? machineDisplayOf(config, rep.source, rep.source).label : "the source";
  const live =
    liveStatuses.find(
      (status) => status.logicalKey === logicalKey && status.environmentId === rep.environmentId,
    ) ?? null;
  const stored = config.projectMountStatus[logicalKey]?.[rep.environmentId];
  if (
    rep.projectId !== undefined &&
    ((!live && !stored) || (rep.role === "primary" && rep.transport === "git"))
  ) {
    return { rep, status: { state: "watching", updatedAt: "" }, text: "Synced", retry: null };
  }
  const state = live?.state ?? stored?.state ?? "pending";
  const conflicts = live ? live.conflicts.length : (stored?.conflicts ?? 0);
  const message = live ? (live.message ?? null) : (stored?.message ?? null);
  const status: SidebarProjectMountStatus = {
    state,
    conflicts,
    ...(message ? { message } : {}),
    ...((live ? live.skipped : stored?.skipped)
      ? {
          skipped: live ? live.skipped! : stored!.skipped!,
          skippedPaths: live ? (live.skippedPaths ?? []) : (stored?.skippedPaths ?? []),
        }
      : {}),
    updatedAt: live?.updatedAt ?? stored?.updatedAt ?? "",
  };
  return {
    rep,
    status,
    text: replicaStatusCopy({
      state,
      progress: live?.progress ?? null,
      conflicts,
      message,
      targetLabel: machine.label,
      sourceLabel: source,
    }),
    retry:
      state === "error" || state === "conflict"
        ? {
            logicalKey,
            rep,
            status,
            live,
            progress: live?.progress ?? null,
            conflicts,
            message,
            projectId: live?.projectId ?? null,
          }
        : null,
  };
}

/** The project id a machine registered, preferring the layout over the live status. */
export function replicaProjectId(
  config: SidebarWorkspacesConfig,
  liveStatuses: ReadonlyArray<ReplicaLiveStatus>,
  logicalKey: string,
  environmentId: string,
): string | null {
  const rep = config.projectMounts[logicalKey]?.find(
    (candidate) => candidate.environmentId === environmentId,
  );
  if (rep?.projectId !== undefined) return rep.projectId;
  return (
    liveStatuses.find(
      (status) => status.logicalKey === logicalKey && status.environmentId === environmentId,
    )?.projectId ?? null
  );
}

/** One list per connected server, merged by (logicalKey, environmentId); the latest wins. */
export function mergeReplicaStatusLists(
  lists: ReadonlyArray<{
    readonly environmentId: string;
    readonly replicas: ReadonlyArray<ReplicaLiveStatus>;
  }>,
): ReplicaLiveStatus[] {
  const merged = new Map<string, ReplicaLiveStatus>();
  for (const list of lists) {
    for (const status of list.replicas) {
      merged.set(`${status.logicalKey}\0${status.environmentId}`, status);
    }
  }
  return [...merged.values()];
}

export interface MeshMachineInfo {
  readonly environmentId: string;
  readonly label: string;
  readonly connected: boolean;
  /** The server runs replicas (`capabilities.replicas`). */
  readonly supportsMesh: boolean;
  /** The main copy of the project whose menu is being built. */
  readonly primary?: boolean;
  /** False when the machine cannot run any usable model for that project; null when unknown. */
  readonly hasUsableModel?: boolean | null;
}

export interface ReplicaMachineChoice {
  readonly environmentId: string;
  readonly label: string;
  readonly tag: string;
  readonly color: string;
  readonly primary: boolean;
  readonly disabled: boolean;
  /** Why the machine is disabled, for the item label. */
  readonly reason: string | null;
}

const MACHINE_NEEDS_MESH = "update this server to use the mesh";
const MACHINE_NO_MODELS = "No models here";

/** The connected machines a folder can start a thread on: main copy first, then by title. */
export function replicaMachineChoices(
  config: SidebarWorkspacesConfig,
  machines: ReadonlyArray<MeshMachineInfo>,
  machineDisplay: (
    environmentId: string,
    fallbackLabel: string,
  ) => {
    readonly label: string;
    readonly tag: string;
    readonly color: string;
  },
): ReplicaMachineChoice[] {
  return machines
    .filter((machine) => machine.connected)
    .map((machine) => {
      const display = machineDisplay(machine.environmentId, machine.label);
      const reason = !machine.supportsMesh
        ? MACHINE_NEEDS_MESH
        : machine.hasUsableModel === false
          ? MACHINE_NO_MODELS
          : null;
      return {
        environmentId: machine.environmentId,
        label: display.label,
        tag: display.tag,
        color: display.color,
        primary: machine.primary === true,
        disabled: reason !== null,
        reason,
      };
    })
    .sort(
      (left, right) =>
        Number(right.primary) - Number(left.primary) || left.label.localeCompare(right.label),
    );
}

export interface ReplicaStatusCopyInput {
  readonly state: SidebarProjectMountStatus["state"];
  readonly progress: number | null;
  readonly conflicts: number;
  readonly message: string | null;
  readonly targetLabel: string;
  readonly sourceLabel: string;
}

/** One short line for a pending row: "Mounting on Remote… 42%", "2 conflicts", … */
export function replicaStatusCopy(input: ReplicaStatusCopyInput): string {
  if (
    input.message &&
    input.state !== "error" &&
    (input.message.startsWith("Resolved ") || /^\d+ files? skipped/u.test(input.message))
  )
    return input.message.replace(
      /^Resolved (\d+) conflicts? automatically/u,
      (_, count: string) =>
        `${count} ${count === "1" ? "conflict" : "conflicts"} resolved automatically`,
    );
  switch (input.state) {
    case "pending":
      return `Preparing ${input.targetLabel}…`;
    case "mounting":
      return input.progress === null
        ? `Copying files to ${input.targetLabel}…`
        : `Copying files to ${input.targetLabel}… ${Math.round(input.progress * 100)}%`;
    case "watching":
      if (input.message === "Manual copy") return "Not synced automatically";
      if (input.message?.startsWith("External folder"))
        return "External folder, not synced automatically";
      return input.message || "Synced";
    case "conflict":
      return input.conflicts === 1 ? "1 conflict" : `${input.conflicts} conflicts`;
    case "paused":
      return "Paused";
    case "error":
      return input.message && /reach|route/iu.test(input.message)
        ? `Can't reach ${input.sourceLabel}`
        : "Copy failed";
    case "removed":
      return "Removed";
  }
}

/** The full reason for a replica row's tooltip when its one-line copy is shortened. */
export function replicaStatusDetail(input: ReplicaStatusCopyInput): string {
  if (input.state === "error") {
    if (!input.message || /reach|route/iu.test(input.message))
      return `Can't reach ${input.sourceLabel} from ${input.targetLabel}. Ask an agent to fix the connection`;
    return `${input.message}. Ask an agent to fix the copy`;
  }
  return replicaStatusCopy(input);
}

/** Fork: live replica streams and the retry command for one client runtime. */
export function createReplicaStatusAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    unmanaged: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:replicas:unmanaged",
      tag: MESH_WS_METHODS.replicasUnmanaged,
    }),
    adopt: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:replicas:adopt",
      tag: MESH_WS_METHODS.replicasAdopt,
    }),
    live: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:replicas:status",
      tag: MESH_WS_METHODS.replicasStatus,
    }),
    retry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:replicas:retry",
      tag: MESH_WS_METHODS.replicasRetry,
    }),
  };
}

export function replicaExecutionLabel(
  config: SidebarWorkspacesConfig | null,
  environmentId: string,
  projectId: string,
  projectEnvironmentId?: string,
): string | null {
  if (!config) return null;
  for (const mounts of Object.values(config.projectMounts)) {
    const ownsProject =
      projectEnvironmentId !== undefined &&
      mounts.some(
        (mount) => mount.environmentId === projectEnvironmentId && mount.projectId === projectId,
      );
    const rep = mounts.find(
      (mount) =>
        mount.environmentId === environmentId && (ownsProject || mount.projectId === projectId),
    );
    if (rep?.role !== "replica") continue;
    const primaryId = rep.source ?? mounts.find((mount) => mount.role === "primary")?.environmentId;
    const primary = primaryId
      ? machineDisplayOf(config, primaryId, "primary machine").label
      : "primary machine";
    return `git on ${primary} · t3 run`;
  }
  return null;
}

/** The connected machines a folder can start a thread on, in the order given. */
export function machineChoices(
  config: SidebarWorkspacesConfig,
  machines: ReadonlyArray<MeshMachineInfo>,
): ReplicaMachineChoice[] {
  return replicaMachineChoices(config, machines, (environmentId, fallbackLabel) =>
    machineDisplayOf(config, environmentId, fallbackLabel),
  );
}

/**
 * Fork targets in picker order: the thread's own machine is never offered, and a
 * machine that can run a model comes before one whose reason ("No models here",
 * needs a newer server) explains why it cannot be picked.
 */
export function forkMachineChoices(
  choices: ReadonlyArray<ReplicaMachineChoice>,
  sourceEnvironmentId: string,
): ReplicaMachineChoice[] {
  return choices
    .filter((choice) => choice.environmentId !== sourceEnvironmentId)
    .sort(
      (left, right) =>
        Number(left.disabled) - Number(right.disabled) || left.label.localeCompare(right.label),
    );
}

/** Stable menu/item id for a machine choice. */
export function machineChoiceId(choice: ReplicaMachineChoice): string {
  return `machine:${choice.environmentId}`;
}

/** The item text: "TAG  Label", with the reason when the server cannot join the mesh. */
export function machineChoiceText(choice: ReplicaMachineChoice): string {
  return choice.disabled
    ? `${choice.tag}  ${choice.label} (${choice.reason})`
    : `${choice.tag}  ${choice.label}`;
}

/** Pending copy rows for one logical project, shared by both Machines views. */
export function pendingRowsForProject(
  config: SidebarWorkspacesConfig,
  liveStatuses: ReadonlyArray<ReplicaLiveStatus>,
  logicalKey: string,
): PendingReplicaRow[] {
  return pendingRows(config, liveStatuses).filter((row) => row.logicalKey === logicalKey);
}

/** Machines that may receive a new replica: enabled and not already represented. */
export function representationCandidates<
  M extends { readonly environmentId: string; readonly disabled: boolean },
>(machines: ReadonlyArray<M>, presentEnvironmentIds: ReadonlySet<string>): M[] {
  return machines.filter(
    (machine) => !machine.disabled && !presentEnvironmentIds.has(machine.environmentId),
  );
}

export interface RemoveRepresentationChoice {
  readonly environmentId: string;
  readonly label: string;
  readonly actionLabel: string;
}

export interface RemoveRepresentationCopyDialog {
  readonly title: string;
  readonly message: string;
  /** False while another copy must be made the main copy first. */
  readonly canRemove: boolean;
  /** Copies that can take over, with their "Make X the main copy" action labels. */
  readonly makePrimary: ReadonlyArray<RemoveRepresentationChoice>;
}

/**
 * Confirm-dialog copy for removing one representation, shared by web and
 * mobile. A main copy cannot be removed while other copies depend on it: the
 * dialog offers making one of them the main copy instead. Files always stay.
 */
export function removeRepresentationCopy(input: {
  readonly role: "primary" | "replica";
  readonly otherCopies: ReadonlyArray<{ readonly environmentId: string; readonly label: string }>;
}): RemoveRepresentationCopyDialog {
  if (input.role === "replica") {
    return {
      title: "Remove this copy?",
      message:
        "Synchronization stops and this copy is removed from the project. Files already on the machine stay where they are.",
      canRemove: true,
      makePrimary: [],
    };
  }
  if (input.otherCopies.length === 0) {
    return {
      title: "Remove the main copy?",
      message:
        "Removing the main copy leaves the project on this machine only as an ordinary folder.",
      canRemove: true,
      makePrimary: [],
    };
  }
  return {
    title: "Remove the main copy?",
    message:
      "The main copy runs git and builds. Make another copy the main copy first, then remove this one.",
    canRemove: false,
    makePrimary: input.otherCopies.map((copy) => ({
      environmentId: copy.environmentId,
      label: copy.label,
      actionLabel: `Make ${copy.label} the main copy`,
    })),
  };
}

export const NO_UNMANAGED_SESSIONS = "No existing sync sessions on this machine.";
export const ADOPTED_SESSION_MESSAGE =
  "Taking over sync. The original session stays paused until the new copy is ready.";

/** The label for one adoptable legacy session. */
export function unmanagedSessionLabel(session: {
  readonly name?: string | null;
  readonly alpha: { readonly path: string };
  readonly beta: { readonly path: string };
}): string {
  return `Adopt ${session.name ?? "existing sync"} · ${session.alpha.path} ↔ ${session.beta.path}`;
}

/** Representations in the Machines view: the main copy first, then copies by machine title. */
export function sortRepresentationsMainFirst<
  T extends { readonly environmentId: string; readonly role: "primary" | "replica" },
>(representations: ReadonlyArray<T>, labelOf: (environmentId: string) => string): T[] {
  return [...representations].sort(
    (left, right) =>
      Number(right.role === "primary") - Number(left.role === "primary") ||
      labelOf(left.environmentId).localeCompare(labelOf(right.environmentId)),
  );
}
