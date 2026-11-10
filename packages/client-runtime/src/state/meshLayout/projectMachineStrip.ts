import type { ReplicaLiveStatus, SidebarWorkspacesConfig } from "@t3tools/contracts";
import { machineDisplayOf, type MachineDisplay } from "../machineDisplay.ts";
import { representationRow } from "./replicas.ts";

export interface ProjectMachineChip {
  readonly environmentId: string;
  readonly machine: MachineDisplay;
  readonly role: "primary" | "replica";
  readonly state: string;
  readonly tone: "green" | "neutral" | "amber" | "red" | "grey";
  readonly pending: boolean;
  /** The representation's machine is not connected to this client. */
  readonly muted: boolean;
  readonly description: string;
}

export interface ProjectMachineStripModel {
  /** Up to three tags drawn inline; a project with more shows `overflow` behind "+N". */
  readonly chips: ReadonlyArray<ProjectMachineChip>;
  /** Machines beyond the third, for the "+N" label and its long-press list. */
  readonly hidden: ReadonlyArray<ProjectMachineChip>;
  readonly overflow: number;
  readonly description: string;
}

export function projectMachineStrip(
  config: SidebarWorkspacesConfig,
  group: {
    readonly projectKey: string;
    readonly environmentIds: ReadonlyArray<string>;
    readonly knownEnvironmentIds: ReadonlyArray<string>;
    /** Machines the mesh reports offline, even if this client has not noticed yet. */
    readonly offlineEnvironmentIds?: ReadonlyArray<string>;
    readonly isScratch?: boolean;
  },
  liveStatuses: ReadonlyArray<ReplicaLiveStatus>,
  displayOf: (environmentId: string) => MachineDisplay = (id) => machineDisplayOf(config, id, id),
  offlineDescriptionOf?: (environmentId: string) => string | null,
): ProjectMachineStripModel {
  const reps = group.isScratch ? [] : (config.projectMounts[group.projectKey] ?? []);
  const connectedHere = new Set(group.knownEnvironmentIds);
  const offlineHere = new Set(group.offlineEnvironmentIds ?? []);
  const known = new Set([
    ...group.knownEnvironmentIds,
    ...Object.keys(config.machines),
    ...Object.values(config.projectMounts).flatMap((mounts) =>
      mounts.map((rep) => rep.environmentId),
    ),
    ...group.environmentIds,
  ]);
  const ordered = [
    ...reps.filter((rep) => rep.role === "primary"),
    ...reps.filter((rep) => rep.role === "replica"),
  ];
  const chips: ProjectMachineChip[] =
    ordered.length > 0
      ? ordered.map((rep) => {
          const { status } = representationRow(config, liveStatuses, group.projectKey, rep);
          const state = status.state;
          const machine = displayOf(rep.environmentId);
          const offline = offlineHere.has(rep.environmentId);
          const detail =
            status.message && (status.message.startsWith("Resolved ") || Boolean(status.skipped))
              ? status.message
              : state === "watching"
                ? "synced"
                : state === "conflict" && status.conflicts
                  ? `${status.conflicts} conflict${status.conflicts === 1 ? "" : "s"}`
                  : state === "pending" || state === "mounting"
                    ? "copying files"
                    : state === "removed"
                      ? "not on this machine"
                      : state === "paused"
                        ? "sync paused"
                        : state === "error"
                          ? "needs attention"
                          : "not synced";
          return {
            environmentId: rep.environmentId,
            machine,
            role: rep.role,
            state,
            tone:
              state === "watching"
                ? "green"
                : state === "conflict"
                  ? "amber"
                  : state === "error"
                    ? "red"
                    : state === "paused" || state === "removed"
                      ? "grey"
                      : "neutral",
            pending: state === "pending" || state === "mounting",
            muted: offline || !connectedHere.has(rep.environmentId),
            description:
              (rep.role === "primary"
                ? `Primary on ${machine.label}`
                : `Replica on ${machine.label} (${detail})`) +
              (offline
                ? offlineDescriptionOf?.(rep.environmentId)
                  ? ` · ${offlineDescriptionOf(rep.environmentId)}`
                  : " · offline"
                : connectedHere.has(rep.environmentId)
                  ? ""
                  : offlineDescriptionOf?.(rep.environmentId)
                    ? ` · ${offlineDescriptionOf(rep.environmentId)}`
                    : ""),
          };
        })
      : [...new Set(group.environmentIds)].map((environmentId) => {
          const machine = displayOf(environmentId);
          const offline = offlineHere.has(environmentId);
          return {
            environmentId,
            machine,
            role: "primary",
            state: "watching",
            tone: "green",
            pending: false,
            muted: offline || !connectedHere.has(environmentId),
            description:
              (group.isScratch ? `Scratch on ${machine.label}` : `Primary on ${machine.label}`) +
              (offline
                ? offlineDescriptionOf?.(environmentId)
                  ? ` · ${offlineDescriptionOf(environmentId)}`
                  : " · offline"
                : connectedHere.has(environmentId)
                  ? ""
                  : offlineDescriptionOf?.(environmentId)
                    ? ` · ${offlineDescriptionOf(environmentId)}`
                    : ""),
          };
        });
  const description = chips.map((chip) => chip.description).join(" · ");
  if (known.size <= 1) return { chips: [], hidden: [], overflow: 0, description };
  const hidden = chips.slice(3);
  return { chips: chips.slice(0, 3), hidden, overflow: hidden.length, description };
}
