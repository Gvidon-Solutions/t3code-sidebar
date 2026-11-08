import { decodeLayoutKey } from "@t3tools/shared/meshLayout";
import * as DateTime from "effect/DateTime";
import type {
  EnvironmentId,
  PeerLinkCreateInput,
  ReplicaLiveStatus,
  SidebarWorkspacesConfig,
} from "@t3tools/contracts";

import { shortMachineHost, machineDisplayOf, type MachineDisplay } from "./machineDisplay.ts";

/**
 * T3 Mesh (fork): one machine as Settings › Mesh shows it. Everything here is derived from the
 * replicated layout, this client's connections and the peer links of every connected server.
 */
export interface MeshMachineConnection {
  readonly environmentId: string;
  readonly label: string;
  readonly version?: string | null;
  readonly connected: boolean;
  readonly platform?: { readonly os: string; readonly arch: string };
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
  readonly error?: string;
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
  readonly network?: import("@t3tools/contracts").PeerConnectionStatus;
  readonly aliases: readonly string[];
  readonly unnamed: boolean;
  readonly platform?: { readonly os: string; readonly arch: string };
  readonly environmentId: string;
  readonly connectedHere: boolean;
  /** Machines connected by an incoming or outgoing peer link. */
  readonly linkedWith: readonly MeshLinkedWith[];
  readonly lastSeenAt?: string | null;
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
}

export interface MeshMachineBuildInput {
  readonly config: SidebarWorkspacesConfig;
  readonly connections?: readonly MeshMachineConnection[];
  readonly links?: readonly MeshLinkSource[];
  readonly peerStates?: readonly MeshPeerStateView[];
  readonly factsObservedAt?: Readonly<Record<string, string | null>>;
  readonly peerConnections?: readonly import("@t3tools/contracts").PeerConnectionStatus[];
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
  const rootIds = new Set(
    connections
      .filter((connection) => connection.connected)
      .map((connection) => connection.environmentId),
  );
  const reports = Object.entries(config.machines).flatMap(([source, machine]) =>
    rootIds.has(source) && machine.reported?.connections
      ? machine.reported.connections.map((connection) => ({
          ...connection,
          sourceEnvironmentId: source,
          observedAt: connection.observedAt ?? machine.reported!.reportedAt,
        }))
      : [],
  );
  const networkBySource = new Map<string, import("@t3tools/contracts").PeerConnectionStatus>();
  const keyOf = (connection: import("@t3tools/contracts").PeerConnectionStatus) =>
    JSON.stringify([connection.sourceEnvironmentId ?? "", connection.environmentId]);
  const currentSources = new Set((input.peerConnections ?? []).map(keyOf));
  for (const connection of [
    ...(input.peerConnections ?? []),
    ...reports.filter((report) => !currentSources.has(keyOf(report))),
  ]) {
    const key = keyOf(connection);
    const previous = networkBySource.get(key);
    if (!previous || (connection.observedAt ?? "") > (previous.observedAt ?? ""))
      networkBySource.set(key, connection);
  }
  const networkStates = [...networkBySource.values()];
  const peerStates = input.peerStates ?? [];
  const connectionById = new Map<string, MeshMachineConnection>();
  for (const entry of connections) {
    const previous = connectionById.get(entry.environmentId);
    const preferred = previous?.connected && !entry.connected ? previous : entry;
    const other = preferred === entry ? previous : entry;
    const platform = preferred.platform ?? other?.platform;
    connectionById.set(entry.environmentId, {
      ...previous,
      ...entry,
      label:
        machineDisplayOf({ machines: {} }, entry.environmentId, preferred.label).label ===
        "Unnamed machine"
          ? (other?.label ?? preferred.label)
          : preferred.label,
      connected: entry.connected || previous?.connected === true,
      version: preferred.version ?? other?.version ?? null,
      ...(platform ? { platform } : {}),
      urls: [...new Set([...(previous?.urls ?? []), ...(entry.urls ?? [])])],
    });
  }

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
      const fallbackLabel =
        connection?.label ??
        links.flatMap((source) => source.links).find((link) => link.environmentId === environmentId)
          ?.label ??
        "";
      const display = machineDisplayOf(config, environmentId, fallbackLabel);
      const incoming = links.flatMap((source) => {
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
      const outgoing = links
        .filter((source) => source.environmentId === environmentId)
        .flatMap((source) =>
          source.links.map((link) => ({
            environmentId: link.environmentId,
            ...machineDisplayOf(
              config,
              link.environmentId,
              connectionById.get(link.environmentId)?.label ?? link.label,
            ),
          })),
        );
      const linkedWith = [
        ...new Map(
          [...incoming, ...outgoing].map((peer) => [
            peer.environmentId,
            { environmentId: peer.environmentId, label: peer.label, tag: peer.tag },
          ]),
        ).values(),
      ];
      const peerLinks = links.flatMap((source) =>
        source.links.filter((link) => link.environmentId === environmentId),
      );
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
      const candidates = networkStates.filter(
        (connection) => connection.environmentId === environmentId,
      );
      const network =
        candidates.find((connection) => connection.state === "direct") ??
        candidates.find((connection) => connection.state === "relayed") ??
        candidates[0];
      const platform = connection?.platform ?? config.machines[environmentId]?.reported?.platform;
      return {
        environmentId,
        ...(network === undefined ? {} : { network }),
        aliases: config.machines[environmentId]?.aliases ?? [],
        unnamed: display.label === "Unnamed machine",
        ...(platform ? { platform } : {}),
        label: Object.keys(config.machines).some(
          (id) => id !== environmentId && machineDisplayOf(config, id, "").label === display.label,
        )
          ? `${display.label} (${platform?.os ?? "unknown OS"} · ${shortMachineHost(urls[0]) ?? display.tag})`
          : display.label,
        tag: display.tag,
        color: display.color,
        connectedHere: connection?.connected === true,
        linkedWith,
        version: connection?.version ?? config.machines[environmentId]?.reported?.version ?? null,
        lastSeenAt:
          [
            peerState?.lastExchangeAt,
            input.factsObservedAt?.[environmentId],
            config.machines[environmentId]?.reported?.reportedAt,
            ...peerLinks.map((link) => link.lastReachedAt),
            ...Object.values(config.projectMounts).flatMap((mounts) =>
              mounts
                .filter((mount) => mount.environmentId === environmentId)
                .map((mount) => mount.createdAt),
            ),
          ]
            .filter((value): value is string => typeof value === "string")
            .sort()
            .at(-1) ?? null,
        lastExchangeAt: peerState?.lastExchangeAt ?? null,
        lastError:
          network?.lastError ??
          peerState?.lastError ??
          links.find((source) => source.environmentId === environmentId && source.error)?.error ??
          peerLinks.find((link) => link.lastError)?.lastError ??
          null,
        sentSeq: peerState?.sentSeq ?? 0,
        receivedSeq: peerState?.receivedSeq ?? 0,
        replicas,
        primaries,
        conflicts,
        urls,
      };
    })
    .filter(
      (machine) =>
        input.factsObservedAt?.[machine.environmentId] !== null ||
        machine.connectedHere ||
        machine.network?.state === "direct" ||
        machine.network?.state === "relayed" ||
        machine.linkedWith.length > 0,
    )
    .map((machine, _index, machines) => {
      const duplicates = machines.filter((other) => other.label === machine.label);
      if (duplicates.length < 2) return machine;
      const ordinal =
        duplicates
          .map((other) => other.environmentId)
          .sort()
          .indexOf(machine.environmentId) + 1;
      return { ...machine, label: `${machine.label} · ${ordinal}` };
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
  const { active: machines } = partitionMeshMachines(input.machines, { machines: {} }, input.now);
  if (!input.enabled || machines.length === 0) return { kind: "hidden" };
  const failing = machines.find(
    (machine) =>
      !machine.connectedHere &&
      machine.network?.state !== "direct" &&
      machine.network?.state !== "relayed" &&
      machine.lastError !== null,
  );
  if (failing !== undefined) {
    const last = failing.lastExchangeAt === null ? input.now : Date.parse(failing.lastExchangeAt);
    const elapsed = Number.isFinite(last) ? Math.max(0, input.now - last) : 0;
    return {
      kind: "unreachable",
      count: machines.length,
      environmentId: failing.environmentId,
      label: failing.label,
      tag: failing.tag,
      minutes: Math.floor(elapsed / 60_000),
    };
  }
  return { kind: "synced", count: machines.length };
}

/** The sidebar footer text, kept out of the components so both clients say the same thing. */
export function meshFooterText(status: MeshFooterStatus): string | null {
  if (status.kind === "hidden") return null;
  if (status.kind === "synced") {
    return `Mesh · ${status.count} ${status.count === 1 ? "machine" : "machines"} · synced`;
  }
  return `Mesh · ${status.tag} unreachable${status.minutes > 0 ? ` for ${status.minutes} min` : ""}`;
}

export async function linkMeshMachines<A>(input: {
  readonly source: EnvironmentId;
  readonly target: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  } | null;
  readonly url: string;
  readonly code: string;
  readonly mintOnTarget: boolean;
  readonly mintCode: (target: EnvironmentId) => Promise<string>;
  readonly link: (source: EnvironmentId, request: PeerLinkCreateInput) => Promise<A>;
}): Promise<A> {
  if (input.target?.environmentId === input.source) throw new Error("Choose another machine.");
  const url = input.url.trim();
  if (!url) throw new Error("Enter the machine's address.");
  const pairingCode =
    input.mintOnTarget && input.target !== null
      ? await input.mintCode(input.target.environmentId)
      : input.code.trim();
  if (!pairingCode) throw new Error("Enter a pairing code from that machine.");
  return input.link(input.source, {
    url,
    pairingCode,
    access: "full-access",
    ...(input.target === null
      ? {}
      : { expectedEnvironmentId: input.target.environmentId, expectedLabel: input.target.label }),
  });
}

export function partitionMeshMachines(
  machines: readonly MeshMachine[],
  config: Pick<SidebarWorkspacesConfig, "machines">,
  now: number,
) {
  const forgotten: MeshMachine[] = [];
  const active: MeshMachine[] = [];
  for (const machine of machines) {
    const seen = [
      machine.lastSeenAt,
      machine.lastExchangeAt,
      config.machines[machine.environmentId]?.reported?.reportedAt,
    ]
      .filter((value): value is string => value != null)
      .map(Date.parse)
      .filter(Number.isFinite);
    const online =
      machine.connectedHere ||
      machine.network?.state === "direct" ||
      machine.network?.state === "relayed";
    if (
      !online &&
      machine.linkedWith.length === 0 &&
      seen.length > 0 &&
      now - Math.max(...seen) >= 7 * 86_400_000
    )
      forgotten.push(machine);
    else active.push(machine);
  }
  return { active, forgotten };
}

export function forgetMachineFacts(
  config: SidebarWorkspacesConfig,
  environmentId: string,
): SidebarWorkspacesConfig {
  const machines = { ...config.machines };
  delete machines[environmentId];
  return {
    ...config,
    machines,
    projectMounts: Object.fromEntries(
      Object.entries(config.projectMounts).map(([key, reps]) => [
        key,
        reps
          .filter((rep) => rep.environmentId !== environmentId)
          .map((rep) => {
            if (rep.source !== environmentId) return rep;
            const { source: _source, ...remaining } = rep;
            return remaining;
          }),
      ]),
    ),
    projectMountStatus: Object.fromEntries(
      Object.entries(config.projectMountStatus).map(([key, statuses]) => {
        const next = { ...statuses };
        delete next[environmentId];
        return [key, next];
      }),
    ),
  };
}

export * from "./meshConfigStatus.ts";

export function meshMachineFactTimes(
  document: Readonly<Record<string, { readonly h: string; readonly v?: unknown }>>,
) {
  const times: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(document)) {
    if (!key.startsWith("machine/") || decodeLayoutKey(key)?.length !== 2) continue;
    const environmentId = decodeURIComponent(key.slice("machine/".length));
    if (entry.v === null) {
      times[environmentId] = null;
      continue;
    }
    const milliseconds = Number(entry.h.slice(0, 13));
    if (Number.isFinite(milliseconds))
      times[environmentId] = DateTime.formatIso(DateTime.makeUnsafe(milliseconds));
  }
  return times;
}

export function offlineMachineText(
  since: string | null | undefined,
  now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
): string {
  const elapsed = since ? Math.max(0, now - Date.parse(since)) : NaN;
  if (!Number.isFinite(elapsed)) return "Offline";
  if (elapsed < 60_000) return "offline now";
  if (elapsed < 3_600_000) return `offline ${Math.floor(elapsed / 60_000)} min`;
  if (elapsed < 86_400_000) return `offline ${Math.floor(elapsed / 3_600_000)} h`;
  return `offline ${Math.floor(elapsed / 86_400_000)} d`;
}

export interface MeshProjectRow {
  readonly key: string;
  readonly title: string;
  readonly sentence: string;
  readonly canRetry: boolean;
}

/** The copies of projects on one machine, in plain words with no file or byte counts. */
export function meshProjectRows(
  config: SidebarWorkspacesConfig,
  environmentId: string,
  liveStatuses: ReadonlyArray<ReplicaLiveStatus> = [],
): MeshProjectRow[] {
  return Object.entries(config.projectMounts).flatMap(([key, reps]) =>
    reps
      .filter((rep) => rep.environmentId === environmentId)
      .map((rep) => {
        const title = config.projectTitles[key] ?? "Project";
        if (rep.role === "primary")
          return { key, title, sentence: `${title} · main copy`, canRetry: false };
        const stored = config.projectMountStatus[key]?.[environmentId];
        const current = liveStatuses.find(
          (status) => status.environmentId === environmentId && status.logicalKey === key,
        );
        const state = current?.state ?? stored?.state;
        const message = current?.message ?? stored?.message ?? null;
        // A manual or external copy can report "watching" without ever syncing
        // automatically; the summary must not call that synced while Diagnostics
        // says otherwise.
        const manual =
          rep.transport === "manual" ||
          message === "Manual copy" ||
          message?.startsWith("External folder") === true;
        const source = rep.source
          ? machineDisplayOf(config, rep.source, rep.source).label
          : "its main copy";
        if (state === "watching")
          return {
            key,
            title,
            sentence: manual
              ? `${title} · copy not synced automatically`
              : `${title} · copy synced`,
            canRetry: false,
          };
        if (state === "mounting" || state === "pending")
          return { key, title, sentence: `${title} · copying files…`, canRetry: false };
        if (state === "conflict")
          return {
            key,
            title,
            sentence: `${title} · copies kept after a conflict`,
            canRetry: false,
          };
        if (state === "error")
          return { key, title, sentence: `${title} · can't reach ${source}`, canRetry: true };
        return { key, title, sentence: `${title} · out of sync`, canRetry: false };
      }),
  );
}

export interface MeshPromptMachine {
  readonly label: string;
  readonly online: boolean;
  readonly detail?: string | null;
}

/** A prepared request for the mesh setup thread: current state, problems and the controls. */
export function meshSetupPrompt(
  machines: ReadonlyArray<MeshPromptMachine>,
  problems: ReadonlyArray<string> = [],
): string {
  const list = machines.map(
    (machine) => `${machine.label} (${machine.online ? "online" : (machine.detail ?? "offline")})`,
  );
  return [
    "Help me set up my T3 mesh.",
    "",
    `Machines: ${list.length > 0 ? list.join(", ") : "none yet"}.`,
    problems.length > 0
      ? `Problems:\n${problems.map((problem) => `- ${problem}`).join("\n")}`
      : "No known problems.",
    "",
    "The desired state lives in one mesh config. You can read it with `t3ctl mesh config get`, preview with `t3ctl mesh config plan`, apply with `t3ctl mesh config apply`, and check reconciliation with `t3ctl mesh status`. The same tools are available as MCP `t3_mesh_config_get`, `t3_mesh_config_plan`, `t3_mesh_config_apply` and `t3_mesh_status`.",
    "Ask me what I want the mesh to do, then plan it, show me the plan, and apply it once I agree.",
  ].join("\n");
}
