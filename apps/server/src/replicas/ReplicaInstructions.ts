import { meshMachineLabel } from "@t3tools/shared/meshLayout";
import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

export function primarySshCommand(
  _config: SidebarWorkspacesConfig,
  _environmentId: string,
  _primaryEnvironmentId: string,
  _path: string,
): string {
  return "t3 run <command>";
}

export function replicaContextNote(
  config: SidebarWorkspacesConfig,
  environmentId: string,
  projectId: string,
): string {
  const entry = Object.entries(config.projectMounts).find(([, reps]) =>
    reps.some((rep) => rep.environmentId === environmentId && rep.projectId === projectId),
  );
  const rep = entry?.[1].find(
    (rep) => rep.environmentId === environmentId && rep.projectId === projectId,
  );
  if (!rep) return "Representation: primary; mode: full; primary: this machine; sync: local.";
  const primary =
    rep.role === "primary"
      ? rep
      : entry?.[1].find(
          (candidate) => candidate.environmentId === rep.source && candidate.role === "primary",
        );
  const mode = rep.role === "primary" ? "full" : (rep.mode ?? "lite");
  const primaryName = primary
    ? meshMachineLabel(config, primary.environmentId, "the primary machine")
    : "unavailable";
  const sync =
    rep.role === "primary"
      ? "local"
      : (config.projectMountStatus[entry![0]]?.[environmentId]?.state ?? "pending");
  return `Representation: ${rep.role}; mode: ${mode}; primary: ${fitUtf8(primaryName, 80)}${primary ? ` at ${fitUtf8(primary.path, 120)}` : ""}; sync: ${sync}. ${rep.role === "replica" ? (mode === "lite" ? "build/test/git: t3 run <cmd>." : "Build/test locally; run git on the primary.") : "Build/test/git locally."}`;
}

const fitUtf8 = (value: string, budget: number) => {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= budget) return value;
  const prefix: string[] = [];
  let used = 0;
  for (const character of value) {
    const size = encoder.encode(character).length;
    if (used + size > budget - 3) break;
    prefix.push(character);
    used += size;
  }
  return `${prefix.join("")}…`;
};

export function threadContextNote(
  threadId: string,
  environmentId: string,
  replicaNote: string,
): string {
  const prefix = `Thread ${fitUtf8(threadId, 160)}; machine ${fitUtf8(environmentId, 80)}. Call t3_thread_self for details.`;
  const note =
    replicaNote ||
    "Representation: primary; mode: full; primary on this machine; sync: local; build/test/git locally.";
  return fitUtf8(`${prefix} ${note}`, 600);
}
