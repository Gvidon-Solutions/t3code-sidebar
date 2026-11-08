import {
  type MeshConfigRevision,
  type MeshConfigStatus,
  type SidebarWorkspacesConfig,
  type ReplicaLiveStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { machineDisplayOf } from "./machineDisplay.ts";
import type { MeshMachine } from "./meshMachines.ts";

function readableReason(message: string) {
  return message.replaceAll("Unknown machine (UN)", "Unnamed machine");
}
function exactLocalTime(at: string | null | undefined): string {
  if (!at) return "";
  const date = DateTime.make(at);
  return date._tag === "None"
    ? ""
    : DateTime.formatLocal(date.value, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
function relativeTime(at: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (!Number.isFinite(minutes)) return "";
  if (minutes === 0) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1440)} d ago`;
}
export function meshConfigApplyGroups(
  status: MeshConfigStatus | null,
  history: readonly MeshConfigRevision[],
  now: number,
) {
  const revisions = new Map(
    history.map((revision, index) => [
      revision.revision,
      { ...revision, sequence: revision.sequence ?? index + 1 },
    ]),
  );
  const groups = new Map<
    string,
    {
      revision: string;
      title: string;
      actions: MeshConfigStatus["servers"][number]["actions"][number][];
    }
  >();
  for (const server of status?.servers ?? []) {
    const revision = server.revision ?? history.at(-1)?.revision ?? "pending";
    const group = groups.get(revision) ?? { revision, title: "", actions: [] };
    for (const action of server.actions)
      if (!group.actions.some((item) => item.id === action.id && item.server === action.server))
        group.actions.push(action);
    groups.set(revision, group);
  }
  for (const group of groups.values()) {
    const config = revisions.get(group.revision);
    const done = group.actions.filter((action) => action.state === "done").length;
    const failed = group.actions.filter((action) => action.state === "failed").length;
    const pending = group.actions.filter((action) => action.state === "in_progress").length;
    group.title = `Config${config ? ` r${config.sequence}` : ""}${pending ? " applying" : config ? ` applied ${relativeTime(config.writtenAt, now)}` : ""} · ${done} ${done === 1 ? "change" : "changes"} done${failed ? `, ${failed} failed` : ""}${pending ? `, ${pending} in progress` : ""}`;
    group.actions = group.actions.map((action) => ({
      ...action,
      ...(action.reason === undefined ? {} : { reason: readableReason(action.reason) }),
      description: readableReason(
        action.description
          .replace(/^Apply display for (.+)$/u, "Machine $1")
          .replace(/^Place (.+) on (.+)$/u, "Replica of $1 on $2")
          .replace(/^Apply ignores to (.+)$/u, "Sync ignores for $1"),
      ),
    }));
  }
  return [...groups.values()].reverse();
}
export interface MeshMachineDetailRow {
  readonly label: string;
  readonly value: string;
  /** Human local time behind a relative "checked ..." phrase, never a raw ISO string. */
  readonly exact?: string;
}

function plainReplicaState(
  key: string,
  machine: MeshMachine,
  config: SidebarWorkspacesConfig,
  live: readonly ReplicaLiveStatus[],
) {
  const current = live.find(
    (item) => item.environmentId === machine.environmentId && item.logicalKey === key,
  );
  const stored = config.projectMountStatus[key]?.[machine.environmentId];
  const state = current?.state ?? stored?.state ?? "pending";
  const rep = config.projectMounts[key]?.find(
    (candidate) => candidate.environmentId === machine.environmentId,
  );
  const source = rep?.source
    ? machineDisplayOf(config, rep.source, "the main copy").label
    : "the main copy";
  const message = current?.message ?? stored?.message ?? null;
  const skipped = current?.skipped ?? stored?.skipped;
  const value =
    state === "watching"
      ? message === "Manual copy"
        ? "Not synced automatically"
        : `Sync running${skipped ? ` · ${skipped} ${skipped === 1 ? "file" : "files"} skipped` : ""}`
      : state === "paused"
        ? "Sync paused"
        : state === "mounting" || state === "pending"
          ? "Copying files"
          : state === "error"
            ? `Can't reach ${source}`
            : state === "conflict"
              ? "Conflicts resolved"
              : state === "removed"
                ? "Removed"
                : "Sync state unknown";
  return { value, exact: exactLocalTime(current?.updatedAt ?? stored?.updatedAt) };
}

export function meshMachineDetailRows(
  machine: MeshMachine,
  config: SidebarWorkspacesConfig,
  live: readonly ReplicaLiveStatus[],
  now = DateTime.toEpochMillis(DateTime.nowUnsafe()),
): MeshMachineDetailRow[] {
  const rows: MeshMachineDetailRow[] = [];
  for (const [target, route] of Object.entries(
    config.machines[machine.environmentId]?.reported?.sshRoutes ?? {},
  ))
    rows.push({
      label: `SSH to ${machineDisplayOf(config, target, "").label}`,
      value: `${route.status === "ok" ? "OK" : route.status === "failed" ? "Failed" : "Unknown"}${route.reason ? ` · ${route.reason}` : ""} · checked ${relativeTime(route.checkedAt, now)}`,
      exact: exactLocalTime(route.checkedAt),
    });
  if (!rows.length) rows.push({ label: "SSH routes", value: "Not reported" });
  for (const [key, reps] of Object.entries(config.projectMounts))
    for (const rep of reps) {
      if (rep.environmentId !== machine.environmentId || rep.role !== "replica") continue;
      rows.push({
        label: config.projectTitles[key] ?? "Project replica",
        ...plainReplicaState(key, machine, config, live),
      });
    }
  return rows;
}
