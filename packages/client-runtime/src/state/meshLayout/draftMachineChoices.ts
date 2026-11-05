import type { SidebarWorkspacesConfig } from "@t3tools/contracts";
import { machineDisplayOf, shortMachineHost } from "../machineDisplay.ts";
import * as Effect from "effect/Effect";

export interface DraftMachineIdentity {
  readonly environmentId: string;
  readonly label?: string | null;
  readonly descriptorLabel?: string | null;
  readonly url?: string | null;
}

function endpoint(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function draftMachineDisplays(
  config: Pick<SidebarWorkspacesConfig, "machines">,
  input: readonly DraftMachineIdentity[],
) {
  const unique = [...new Map(input.map((machine) => [machine.environmentId, machine])).values()];
  const rows = unique.map((machine) => ({
    ...machine,
    ...machineDisplayOf(
      config,
      machine.environmentId,
      machine.descriptorLabel || machine.label || endpoint(machine.url) || "Machine",
    ),
  }));
  const collisions: { label: string; environmentIds: string[] }[] = [];
  for (const label of new Set(rows.map((row) => row.label))) {
    const group = rows.filter((row) => row.label === label);
    if (group.length < 2) continue;
    collisions.push({ label, environmentIds: group.map((row) => row.environmentId).sort() });
    for (const row of group) {
      const tag = config.machines[row.environmentId]?.tag;
      const distinctTag = tag && group.every((other) => other === row || other.tag !== row.tag);
      const host = shortMachineHost(row.url);
      const platform = config.machines[row.environmentId]?.reported?.platform;
      row.label = `${label} (${platform ? `${platform.os} · ${host ?? row.tag}` : distinctTag ? row.tag : (host ?? "not connected")})`;
    }
    const duplicates = group.filter((row) =>
      group.some((other) => other !== row && other.label === row.label),
    );
    for (const [index, row] of duplicates
      .sort((a, b) => a.environmentId.localeCompare(b.environmentId))
      .entries())
      row.label += ` · ${index + 1}`;
  }
  return { rows, collisions };
}

export function draftMachineStatus(input: {
  connected: boolean;
  hasProject: boolean;
  error?: string | null | undefined;
}): string {
  if (input.connected) return input.hasProject ? "here" : "copy will be created";
  if (!input.error) return "not connected";
  const reason = /did not answer|timed? out|timeout/i.test(input.error)
    ? "no response"
    : /failed to fetch|network request failed|ECONNREFUSED/i.test(input.error)
      ? "connection failed"
      : input.error.split("\n")[0]!.slice(0, 64);
  return `unreachable · ${reason}`;
}

const loggedCollisions = new Set<string>();
export function logDraftMachineCollisions(
  collisions: readonly { label: string; environmentIds: string[] }[],
  log: (
    message: string,
    collisions: readonly { label: string; environmentIds: string[] }[],
  ) => void = (message, collisions) => Effect.runSync(Effect.logWarning(message, collisions)),
): void {
  if (collisions.length === 0) return;
  const key = JSON.stringify(collisions);
  if (loggedCollisions.has(key)) return;
  loggedCollisions.add(key);
  log("[mesh] Duplicate machine labels disambiguated", collisions);
}
