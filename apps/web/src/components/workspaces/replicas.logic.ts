import {
  pendingRows,
  replicaMachineChoices,
  type MeshMachineInfo,
  type PendingReplicaRow,
  type ReplicaMachineChoice,
} from "@t3tools/client-runtime/state/mesh-layout";
import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import type {
  ContextMenuItem,
  ReplicaLiveStatus,
  SidebarWorkspacesConfig,
} from "@t3tools/contracts";

// Fork: the sidebar's "new thread on a machine" choices and pending replica rows.

export interface WebMachineInput {
  readonly environmentId: string;
  readonly label: string;
  readonly connected: boolean;
  readonly supportsMesh: boolean;
}

export function folderMachineChoices(
  config: SidebarWorkspacesConfig,
  machines: ReadonlyArray<WebMachineInput>,
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

/** A context-menu item per machine; an unsupported server carries the reason in its label. */
export function machineMenuItems(choices: ReadonlyArray<ReplicaMachineChoice>): ContextMenuItem[] {
  return choices.map((choice) => ({
    id: `machine:${choice.environmentId}`,
    label: choice.disabled
      ? `${choice.tag}  ${choice.label} (${choice.reason})`
      : `${choice.tag}  ${choice.label}`,
    disabled: choice.disabled,
  }));
}

export function folderPendingRows(
  config: SidebarWorkspacesConfig,
  liveStatuses: ReadonlyArray<ReplicaLiveStatus>,
  logicalKey: string,
): PendingReplicaRow[] {
  return pendingRows(config, liveStatuses).filter((row) => row.logicalKey === logicalKey);
}

/** The representation a new logical project starts from: this folder's own project. */
export function primarySeedOf(
  members: ReadonlyArray<{
    readonly environmentId: string;
    readonly id: string;
    readonly workspaceRoot: string;
  }>,
  preferredEnvironmentId: string | null,
): { environmentId: string; path: string; projectId: string } | null {
  const member =
    members.find((candidate) => candidate.environmentId === preferredEnvironmentId) ?? members[0];
  return member
    ? { environmentId: member.environmentId, path: member.workspaceRoot, projectId: member.id }
    : null;
}
