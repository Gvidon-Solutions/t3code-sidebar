import type {
  SidebarMachineReach,
  SidebarWorkspacesConfig,
} from "@t3tools/contracts";

import { machineDisplayOf, type MachineDisplay } from "./machineDisplay.ts";

/**
 * T3 Mesh (fork): one machine as Settings › Mesh shows it. Everything here is derived from the
 * replicated layout, this client's connections and the peer links of every connected server.
 */
export interface MeshMachineConnection {
  readonly environmentId: string;
  readonly label: string;
  readonly version?: string | null;
  readonly connected: boolean;
  /** Addresses this client knows for the machine, most preferred first. */
  readonly urls?: readonly string[];
}

export interface MeshPeerLinkView {
  readonly environmentId: string;
  readonly label: string;
  readonly urls?: readonly string[];
  readonly status?: string;
  readonly lastReachedAt?: string | null;
  readonly lastError?: string | null;
}

/** The links one connected server holds. */
export interface MeshLinkSource {
  readonly environmentId: string;
  readonly links: readonly MeshPeerLinkView[];
}

export interface MeshPeerStateView {
  readonly environmentId: string;
  readonly lastExchangeAt: string | null;
  readonly lastError: string | null;
  readonly sentSeq: number;
  readonly receivedSeq: number;
}

export interface MeshLinkedWith {
  readonly environmentId: string;
  readonly label: string;
  readonly tag: string;
}

export interface MeshMachine extends MachineDisplay {
  readonly environmentId: string;
  readonly connectedHere: boolean;
  /** Connected servers that hold a link to this machine. */
  readonly linkedWith: readonly MeshLinkedWith[];
  readonly version: string | null;
  /** The last successful layout exchange, as the server recorded it. */
  readonly lastExchangeAt: string | null;
  readonly lastError: string | null;
  readonly sentSeq: number;
  readonly receivedSeq: number;
  readonly replicas: number;
  readonly primaries: number;
  readonly conflicts: number;
  readonly urls: readonly string[];
  readonly reach: Readonly<Record<string, SidebarMachineReach>>;
}

export interface MeshMachineBuildInput {
  readonly config: SidebarWorkspacesConfig;
  readonly connections?: readonly MeshMachineConnection[];
  readonly links?: readonly MeshLinkSource[];
  readonly peerStates?: readonly MeshPeerStateView[];
}

function newest(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left >= right ? left : right;
}

function mergePeerStates(states: ReadonlyArray<MeshPeerStateView>): MeshPeerStateView | null {
  let merged: MeshPeerStateView | null = null;
  for (const state of states) {
    if (merged === null) {
      merged = state;
      continue;
    }
    merged = {
      environmentId: merged.environmentId,
      lastExchangeAt: newest(merged.lastExchangeAt, state.lastExchangeAt),
      lastError: state.lastError ?? merged.lastError,
      sentSeq: Math.max(merged.sentSeq, state.sentSeq),
      receivedSeq: Math.max(merged.receivedSeq, state.receivedSeq),
    };
  }
  return merged;
}

/**
 * Every machine the mesh knows about: this client's environments, the layout's machine entries,
 * representations and their statuses, both ends of every peer link, and every replication peer.
 */
export function buildMeshMachines(input: MeshMachineBuildInput): MeshMachine[] {
  const { config } = input;
  const connections = input.connections ?? [];
  const links = input.links ?? [];
  const peerStates = input.peerStates ?? [];
  const connectionById = new Map(connections.map((entry) => [entry.environmentId, entry]));

  const ids = new Set<string>();
  for (const connection of connections) ids.add(connection.environmentId);
  for (const environmentId of Object.keys(config.machines)) ids.add(environmentId);
  for (const mounts of Object.values(config.projectMounts)) {
    for (const mount of mounts) {
      ids.add(mount.environmentId);
      if (mount.source !== undefined) ids.add(mount.source);
    }
  }
  for (const statuses of Object.values(config.projectMountStatus)) {
    for (const environmentId of Object.keys(statuses)) ids.add(environmentId);
  }
  for (const source of links) {
    ids.add(source.environmentId);
    for (const link of source.links) ids.add(link.environmentId);
  }
  for (const state of peerStates) ids.add(state.environmentId);

  return [...ids]
    .sort((left, right) => left.localeCompare(right))
    .map((environmentId) => {
      const connection = connectionById.get(environmentId);
      const fallbackLabel = connection?.label ?? "";
      const display = machineDisplayOf(config, environmentId, fallbackLabel);
      const linkedWith = links.flatMap((source) => {
        if (source.environmentId === environmentId) return [];
        if (!source.links.some((link) => link.environmentId === environmentId)) return [];
        const sourceDisplay = machineDisplayOf(
          config,
          source.environmentId,
          connectionById.get(source.environmentId)?.label ?? source.environmentId,
        );
        return [
          {
            environmentId: source.environmentId,
            label: sourceDisplay.label,
            tag: sourceDisplay.tag,
          },
        ];
      });
      let replicas = 0;
      let primaries = 0;
      let conflicts = 0;
      for (const [projectKey, mounts] of Object.entries(config.projectMounts)) {
        for (const mount of mounts) {
          if (mount.environmentId !== environmentId) continue;
          if (mount.role === "replica") replicas += 1;
          else primaries += 1;
          const status = config.projectMountStatus[projectKey]?.[environmentId];
          if (status === undefined) continue;
          conflicts += status.conflicts ?? (status.state === "conflict" ? 1 : 0);
        }
      }
      const urls = [
        ...new Set([
          ...(connection?.urls ?? []),
          ...links.flatMap((source) =>
            source.links
              .filter((link) => link.environmentId === environmentId)
              .flatMap((link) => link.urls ?? []),
          ),
        ]),
      ];
      const peerState = mergePeerStates(
        peerStates.filter((state) => state.environmentId === environmentId),
      );
      const reach: Record<string, SidebarMachineReach> = {
        ...(config.machines[environmentId]?.reach ?? {}),
      };
      return {
        environmentId,
        label: display.label,
        tag: display.tag,
        color: display.color,
        connectedHere: connection?.connected === true,
        linkedWith,
        version: connection?.version ?? null,
        lastExchangeAt: peerState?.lastExchangeAt ?? null,
        lastError: peerState?.lastError ?? null,
        sentSeq: peerState?.sentSeq ?? 0,
        receivedSeq: peerState?.receivedSeq ?? 0,
        replicas,
        primaries,
        conflicts,
        urls,
        reach,
      };
    });
}

export type MeshFooterStatus =
  | { readonly kind: "hidden" }
  | { readonly kind: "synced"; readonly count: number }
  | {
      readonly kind: "unreachable";
      readonly count: number;
      readonly environmentId: string;
      readonly label: string;
      readonly tag: string;
      readonly minutes: number;
    };

/** A minute by minute reading of the footer line; `hidden` when the mesh is off or unknown. */
export function deriveMeshFooterStatus(input: {
  readonly enabled: boolean;
  readonly machines: readonly MeshMachine[];
  readonly now: number;
}): MeshFooterStatus {
  if (!input.enabled || input.machines.length === 0) return { kind: "hidden" };
  const failing = input.machines.find((machine) => machine.lastError !== null);
  if (failing !== undefined) {
    const last = failing.lastExchangeAt === null ? input.now : Date.parse(failing.lastExchangeAt);
    const elapsed = Number.isFinite(last) ? Math.max(0, input.now - last) : 0;
    return {
      kind: "unreachable",
      count: input.machines.length,
      environmentId: failing.environmentId,
      label: failing.label,
      tag: failing.tag,
      minutes: Math.floor(elapsed / 60_000),
    };
  }
  return { kind: "synced", count: input.machines.length };
}

/** The sidebar footer text, kept out of the components so both clients say the same thing. */
export function meshFooterText(status: MeshFooterStatus): string | null {
  if (status.kind === "hidden") return null;
  if (status.kind === "synced") {
    return `Mesh · ${status.count} ${status.count === 1 ? "machine" : "machines"} · synced`;
  }
  return `Mesh · ${status.tag} unreachable${status.minutes > 0 ? ` for ${status.minutes} min` : ""}`;
}

/** How long since this machine's layout last changed hands, in words. */
export function meshMachineLastSync(machine: MeshMachine, now: number): string {
  if (machine.lastExchangeAt === null) return "Never synced";
  const at = Date.parse(machine.lastExchangeAt);
  if (!Number.isFinite(at)) return "Never synced";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Synced ${hours} h ago`;
  return `Synced ${Math.floor(hours / 24)} d ago`;
}

export function machineReachOf(
  config: SidebarWorkspacesConfig,
  machineEnvironmentId: string,
  targetEnvironmentId: string,
): SidebarMachineReach | null {
  return config.machines[machineEnvironmentId]?.reach?.[targetEnvironmentId] ?? null;
}

/** Saves one ssh route, or removes it when the destination is empty. Never mutates `config`. */
export function setMachineReach(
  config: SidebarWorkspacesConfig,
  machineEnvironmentId: string,
  targetEnvironmentId: string,
  reach: { readonly ssh: string; readonly identityFile?: string | null } | null,
): SidebarWorkspacesConfig {
  const ssh = reach?.ssh.trim() ?? "";
  const identityFile = reach?.identityFile?.trim() ?? "";
  const next: { label?: string; tag?: string; color?: string; reach?: Record<string, SidebarMachineReach> } =
    { ...config.machines[machineEnvironmentId] };
  const routes = { ...(next.reach ?? {}) };
  if (ssh.length === 0) delete routes[targetEnvironmentId];
  else
    routes[targetEnvironmentId] = {
      ssh,
      ...(identityFile.length > 0 ? { identityFile } : {}),
    };
  if (Object.keys(routes).length === 0) delete next.reach;
  else next.reach = routes;
  const machines = { ...config.machines };
  if (Object.keys(next).length === 0) delete machines[machineEnvironmentId];
  else machines[machineEnvironmentId] = next;
  return { ...config, machines };
}
