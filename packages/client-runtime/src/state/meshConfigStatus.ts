import {
  MeshConfigRevision,
  type MeshConfigStatus,
  type SidebarWorkspacesConfig,
  type ReplicaLiveStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { machineDisplayOf } from "./machineDisplay.ts";
import type { MeshMachine } from "./meshMachines.ts";

const isRevision = Schema.is(MeshConfigRevision);
export function meshConfigHistory(
  document: Readonly<Record<string, { readonly v: unknown }>>,
): MeshConfigRevision[] {
  const revisions = new Map<string, MeshConfigRevision>();
  for (const [key, entry] of Object.entries(document))
    if ((key === "mesh.config" || key.startsWith("mesh.configHistory/")) && isRevision(entry.v))
      revisions.set(entry.v.revision, entry.v);
  return [...revisions.values()].sort((a, b) => a.writtenAt.localeCompare(b.writtenAt));
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
      description: action.description
        .replace(/^Apply display for (.+)$/u, "Machine $1")
        .replace(/^Place (.+) on (.+)$/u, "Replica of $1 on $2")
        .replace(/^Apply ignores to (.+)$/u, "Sync ignores for $1"),
    }));
  }
  return [...groups.values()].reverse();
}
export function meshMachineDetailRows(
  machine: MeshMachine,
  config: SidebarWorkspacesConfig,
  live: readonly ReplicaLiveStatus[],
) {
  const rows: { label: string; value: string }[] = [];
  for (const [target, route] of Object.entries(
    config.machines[machine.environmentId]?.reported?.sshRoutes ?? {},
  ))
    rows.push({
      label: `SSH to ${machineDisplayOf(config, target, "").label}`,
      value: `${route.status === "ok" ? "OK" : route.status === "failed" ? "Failed" : "Unknown"}${route.reason ? ` · ${route.reason}` : ""} · checked ${route.checkedAt}`,
    });
  if (!rows.length) rows.push({ label: "SSH routes", value: "Not reported" });
  for (const [key, reps] of Object.entries(config.projectMounts))
    for (const rep of reps) {
      if (rep.environmentId !== machine.environmentId || rep.role !== "replica") continue;
      const current = live.find(
        (item) => item.environmentId === machine.environmentId && item.logicalKey === key,
      );
      const stored = config.projectMountStatus[key]?.[machine.environmentId];
      const lag = current?.lag;
      rows.push({
        label: config.projectTitles[key] ?? "Project replica",
        value: `${current?.state ?? stored?.state ?? "Unknown"} · ${lag ? `${lag.filesBehind} ${lag.filesBehind === 1 ? "file" : "files"} behind${lag.bytesBehind === undefined ? "" : ` · ${lag.bytesBehind} bytes behind`}` : "Lag not reported"}${(current?.message ?? stored?.message) ? ` · ${current?.message ?? stored?.message}` : ""}`,
      });
    }
  return rows;
}
