import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

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
