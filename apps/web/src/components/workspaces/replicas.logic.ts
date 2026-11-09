import {
  machineChoiceId,
  machineChoiceText,
  machineChoices,
  pendingRowsForProject,
  type MeshMachineInfo,
  type PendingReplicaRow,
  type ReplicaMachineChoice,
} from "@t3tools/client-runtime/state/mesh-layout";
import type {
  ContextMenuItem,
  ReplicaLiveStatus,
  SidebarWorkspacesConfig,
} from "@t3tools/contracts";

// Fork: the sidebar's "new thread on a machine" choices and pending replica rows.

export type WebMachineInput = MeshMachineInfo;

export function folderMachineChoices(
  config: SidebarWorkspacesConfig,
  machines: ReadonlyArray<WebMachineInput>,
  logicalKey?: string,
): ReplicaMachineChoice[] {
  const mounts = logicalKey === undefined ? [] : (config.projectMounts[logicalKey] ?? []);
  return machineChoices(
    config,
    machines.map((machine) => ({
      ...machine,
      primary: mounts.some(
        (rep) => rep.environmentId === machine.environmentId && rep.role === "primary",
      ),
    })),
  );
}

/** A context-menu item per machine; an unsupported server carries the reason in its label. */
export function machineMenuItems(choices: ReadonlyArray<ReplicaMachineChoice>): ContextMenuItem[] {
  return choices.map((choice) => ({
    id: machineChoiceId(choice),
    label: machineChoiceText(choice),
    disabled: choice.disabled,
  }));
}

export function folderPendingRows(
  config: SidebarWorkspacesConfig,
  liveStatuses: ReadonlyArray<ReplicaLiveStatus>,
  logicalKey: string,
): PendingReplicaRow[] {
  return pendingRowsForProject(config, liveStatuses, logicalKey);
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
