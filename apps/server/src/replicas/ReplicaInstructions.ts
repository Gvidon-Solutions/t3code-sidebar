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
  const reps = Object.values(config.projectMounts).find((reps) =>
    reps.some((rep) => rep.environmentId === environmentId && rep.projectId === projectId),
  );
  const replica = reps?.find(
    (rep) =>
      rep.environmentId === environmentId && rep.projectId === projectId && rep.role === "replica",
  );
  const primary = replica && reps?.find((rep) => rep.environmentId === replica.source);
  if (!replica || !primary) return "";
  const route = config.machines[environmentId]?.reach?.[primary.environmentId];
  if (!route)
    return `This project is a synchronized replica of ${primary.environmentId}:${primary.path}. Run git and builds on that primary. Add an SSH reach route before running those commands.`;
  const ssh = route.identityFile ? `t3-mesh-${primary.environmentId}` : route.ssh;
  const port = /^(.*):(\d+)$/.exec(ssh);
  const command = port ? `ssh -p ${port[2]} ${quote(port[1]!)}` : `ssh ${quote(ssh)}`;
  return `This project is a synchronized replica. Run git and builds on the primary (${primary.environmentId}), using ${command} ${quote(`cd ${quote(primary.path)} && <command>`)}. Mutagen synchronizes working files in both directions; .git and build dependencies stay on the primary.`;
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
