import {
  pendingRows,
  replicaDriverEnvironment,
  replicaMachineChoices,
  replicaStatusCopy,
  type MeshMachineInfo,
  type ReplicaMachineChoice,
} from "@t3tools/client-runtime/state/mesh-layout";
import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import type {
  ReplicaLiveStatus,
  SidebarProjectMountState,
  SidebarWorkspacesConfig,
} from "@t3tools/contracts";

// Fork: the phone's "new thread on a machine" menu entries and pending replica rows.

export interface MobileMachineInput {
  readonly environmentId: string;
  readonly label: string;
  readonly connected: boolean;
  readonly supportsMesh: boolean;
}

export function mobileMachineChoices(
  config: SidebarWorkspacesConfig,
  machines: ReadonlyArray<MobileMachineInput>,
): ReplicaMachineChoice[] {
  const infos: MeshMachineInfo[] = machines.map((machine) => ({
    environmentId: machine.environmentId,
    label: machine.label,
    connected: machine.connected,
    supportsMesh: machine.supportsMesh,
  }));
  return replicaMachineChoices(config, infos, (environmentId, fallbackLabel) =>
    machineDisplayOf(config, environmentId, fallbackLabel),
  );
}

export interface MachineSubaction {
  readonly id: string;
  readonly title: string;
  readonly disabled: boolean;
}

/** Native menu subactions for "New thread on"; the reason rides in the title when disabled. */
export function machineSubactions(
  choices: ReadonlyArray<ReplicaMachineChoice>,
): MachineSubaction[] {
  return choices.map((choice) => ({
    id: `machine:${choice.environmentId}`,
    title: choice.disabled
      ? `${choice.tag}  ${choice.label} (${choice.reason})`
      : `${choice.tag}  ${choice.label}`,
    disabled: choice.disabled,
  }));
}

export interface MobilePendingReplicaItem {
  readonly key: string;
  readonly projectKey: string;
  readonly environmentId: string;
  readonly tag: string;
  readonly label: string;
  readonly color: string;
  readonly text: string;
  readonly state: SidebarProjectMountState;
  readonly conflicts: number;
  /** The server to call `replicas.retry` on, when a route exists. */
  readonly retryEnvironmentId: string | null;
}

export function mobilePendingReplicaItems(
  config: SidebarWorkspacesConfig,
  liveStatuses: ReadonlyArray<ReplicaLiveStatus>,
  projectKey: string,
): MobilePendingReplicaItem[] {
  return pendingRows(config, liveStatuses)
    .filter((row) => row.logicalKey === projectKey)
    .map((row) => {
      const display = machineDisplayOf(config, row.rep.environmentId, row.rep.environmentId);
      const sourceLabel = row.rep.source
        ? machineDisplayOf(config, row.rep.source, row.rep.source).label
        : "the source";
      return {
        key: `replica:${row.logicalKey}:${row.rep.environmentId}`,
        projectKey: row.logicalKey,
        environmentId: row.rep.environmentId,
        tag: display.tag,
        label: display.label,
        color: display.color,
        text: replicaStatusCopy({
          state: row.status.state,
          progress: row.progress,
          conflicts: row.conflicts,
          message: row.message,
          targetLabel: display.label,
          sourceLabel,
        }),
        state: row.status.state,
        conflicts: row.conflicts,
        retryEnvironmentId: replicaDriverEnvironment(config, row.rep),
      };
    });
}
