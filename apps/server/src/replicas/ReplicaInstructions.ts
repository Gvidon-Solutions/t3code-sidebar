import { meshMachineLabel } from "@t3tools/shared/meshLayout";
import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function primarySshCommand(
  config: SidebarWorkspacesConfig,
  environmentId: string,
  primaryEnvironmentId: string,
  path: string,
): string | null {
  const route = config.machines[environmentId]?.reach?.[primaryEnvironmentId];
  if (!route) return null;
  const ssh = route.identityFile ? `t3-mesh-${primaryEnvironmentId}` : route.ssh;
  const port = /^(.*):(\d+)$/.exec(ssh);
  const command = port ? `ssh -p ${port[2]} ${quote(port[1]!)}` : `ssh ${quote(ssh)}`;
  return `${command} ${quote(`cd ${quote(path)} && <command>`)}`;
}

export function replicaContextNote(
  config: SidebarWorkspacesConfig,
  environmentId: string,
  projectId: string,
): string {
  const entry = Object.entries(config.projectMounts).find(([, reps]) =>
    reps.some((rep) => rep.environmentId === environmentId && rep.projectId === projectId),
  );
  const replica = entry?.[1].find(
    (rep) =>
      rep.environmentId === environmentId && rep.projectId === projectId && rep.role === "replica",
  );
  if (!entry || !replica) return "";
  const mode = replica.mode ?? "lite";
  const sync = config.projectMountStatus[entry[0]]?.[environmentId]?.state ?? "unknown";
  const primary = entry[1].find(
    (rep) => rep.environmentId === replica.source && rep.role === "primary",
  );
  if (!primary)
    return `This is a ${mode} replica; its primary representation is unavailable. Sync: ${sync}. Restore the primary before running commands.`;
  const machine = fitUtf8(
    meshMachineLabel(config, primary.environmentId, "the primary machine"),
    80,
  );
  const command =
    mode === "lite"
      ? "Use t3 run -- <command> for git, dependencies, builds and tests."
      : "Commands run locally here; git stays on the primary.";
  return `This is a ${mode} replica. ${command} The environment is on ${machine} at ${fitUtf8(primary.path, 100)}. Sync: ${sync}.`;
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
  const note = replicaNote || "This project is primary on this machine.";
  return fitUtf8(`${prefix} ${note}`, 600);
}
