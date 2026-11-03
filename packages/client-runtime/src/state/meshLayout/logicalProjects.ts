import type { SidebarWorkspacesConfig, SidebarProjectMount } from "@t3tools/contracts";
import { normalizeRepresentationPath } from "@t3tools/shared/meshLayout";
import { machineDisplayOf } from "../machineDisplay.ts";
type Project = { readonly environmentId: string; readonly workspaceRoot: string };
function follow(key: string, config: SidebarWorkspacesConfig): string {
  const seen: string[] = [];
  for (let i = 0; i < 8; i++) {
    if (seen.includes(key)) return [...seen, key].sort()[0]!;
    seen.push(key);
    const next = config.projectAliases[key];
    if (!next) return key;
    key = next;
  }
  return key;
}
export function resolveLogicalProjectKey<T extends Project>(
  project: T,
  config: SidebarWorkspacesConfig,
  deriveFallback: (project: T) => string,
): string {
  const path = normalizeRepresentationPath(project.workspaceRoot);
  const match = Object.keys(config.projectMounts)
    .sort()
    .find((key) =>
      config.projectMounts[key]!.some(
        (rep) =>
          rep.environmentId === project.environmentId &&
          normalizeRepresentationPath(rep.path) === path,
      ),
    );
  const physical = `${project.environmentId}:${path}`;
  return follow(
    match ?? (config.projectAliases[physical] ? physical : deriveFallback(project)),
    config,
  );
}
export function addRepresentation(
  config: SidebarWorkspacesConfig,
  key: string,
  rep: SidebarProjectMount,
): SidebarWorkspacesConfig {
  return {
    ...config,
    projectMounts: {
      ...config.projectMounts,
      [key]: [
        ...(config.projectMounts[key] ?? []).filter((r) => r.environmentId !== rep.environmentId),
        rep,
      ].sort((a, b) =>
        a.environmentId < b.environmentId ? -1 : a.environmentId > b.environmentId ? 1 : 0,
      ),
    },
  };
}
export function removeRepresentation(
  config: SidebarWorkspacesConfig,
  key: string,
  environmentId: string,
): SidebarWorkspacesConfig {
  const projectMounts = { ...config.projectMounts },
    projectMountStatus = { ...config.projectMountStatus };
  const reps = (projectMounts[key] ?? []).filter((r) => r.environmentId !== environmentId);
  if (reps.length) projectMounts[key] = reps;
  else delete projectMounts[key];
  const statuses = { ...projectMountStatus[key] };
  delete statuses[environmentId];
  if (Object.keys(statuses).length) projectMountStatus[key] = statuses;
  else delete projectMountStatus[key];
  return { ...config, projectMounts, projectMountStatus };
}
export function setPrimary(
  config: SidebarWorkspacesConfig,
  key: string,
  environmentId: string,
): SidebarWorkspacesConfig {
  const rep = config.projectMounts[key]?.find((r) => r.environmentId === environmentId);
  if (!rep) return config;
  const { source: _source, ...rest } = rep;
  return addRepresentation(config, key, { ...rest, role: "primary" });
}
export function mergeLogicalProjects(
  config: SidebarWorkspacesConfig,
  from: string,
  into: string,
): SidebarWorkspacesConfig {
  into = follow(into, config);
  if (from === into) return config;
  const replace = (p: string) => (p === from ? into : p);
  const projectAliases = Object.fromEntries(
    Object.entries(config.projectAliases)
      .filter(([k]) => k !== into)
      .map(([k, v]) => [k, replace(v)]),
  );
  projectAliases[from] = into;
  const placements = { ...config.placements };
  const union = [...new Set([...(placements[into] ?? []), ...(placements[from] ?? [])])];
  delete placements[from];
  if (union.length) {
    const rank = new Map(config.workspaces.map((w, i) => [w.id, i]));
    placements[into] = union.sort(
      (a, b) =>
        (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0),
    );
  }
  const assignments = { ...config.assignments };
  if (assignments[from] && !assignments[into]) assignments[into] = assignments[from]!;
  delete assignments[from];
  if (placements[into]?.length) assignments[into] = placements[into]![0]!;
  const projectMounts = { ...config.projectMounts },
    projectMountStatus = { ...config.projectMountStatus };
  if (projectMounts[from])
    projectMounts[into] = [
      ...new Map(
        [...(projectMounts[from] ?? []), ...(projectMounts[into] ?? [])].map((r) => [
          r.environmentId,
          r,
        ]),
      ).values(),
    ].sort((a, b) =>
      a.environmentId < b.environmentId ? -1 : a.environmentId > b.environmentId ? 1 : 0,
    );
  delete projectMounts[from];
  if (projectMountStatus[from])
    projectMountStatus[into] = { ...projectMountStatus[from], ...projectMountStatus[into] };
  delete projectMountStatus[from];
  return {
    ...config,
    projectAliases,
    placements,
    assignments,
    projectMounts,
    projectMountStatus,
    projectOrder: [...new Set(config.projectOrder.map(replace))],
    workspaceProjectOrder: Object.fromEntries(
      Object.entries(config.workspaceProjectOrder).map(([ws, order]) => [
        ws,
        [...new Set(order.map(replace))],
      ]),
    ),
    workspaceFold: Object.fromEntries(
      Object.entries(config.workspaceFold).map(([ws, fold]) => {
        const next = { ...fold };
        if (next[from] && !next[into]) next[into] = next[from]!;
        delete next[from];
        return [ws, next];
      }),
    ),
  };
}
export function splitLogicalProject(
  config: SidebarWorkspacesConfig,
  from: string,
  environmentId: string,
  into: string,
  project?: { readonly workspaceRoot: string; readonly id: string },
): SidebarWorkspacesConfig {
  const rep =
    config.projectMounts[from]?.find((r) => r.environmentId === environmentId) ??
    (project === undefined
      ? undefined
      : {
          environmentId,
          path: project.workspaceRoot,
          projectId: project.id,
          transport: "git" as const,
          role: "primary" as const,
          createdAt: "",
        });
  if (!rep || from === into) return config;
  const status = config.projectMountStatus[from]?.[environmentId];
  let next = addRepresentation(removeRepresentation(config, from, environmentId), into, rep);
  const physical = `${environmentId}:${normalizeRepresentationPath(rep.path)}`;
  const projectAliases = { ...next.projectAliases };
  delete projectAliases[into];
  projectAliases[physical] = into;
  next = { ...next, projectAliases };
  if (status)
    next = {
      ...next,
      projectMountStatus: {
        ...next.projectMountStatus,
        [into]: { ...next.projectMountStatus[into], [environmentId]: status },
      },
    };
  return next;
}
export function suggestMerges<T extends Project & { readonly title: string }>(
  projects: readonly T[],
): T[][] {
  const groups = new Map<string, T[]>();
  for (const project of projects) {
    const title = project.title.trim().replace(/\s+/g, " ").toLowerCase();
    if (title) groups.set(title, [...(groups.get(title) ?? []), project]);
  }
  return [...groups.values()].filter(
    (group) => new Set(group.map((p) => p.environmentId)).size > 1,
  );
}

/** A short machine tag for hints and thread chips; falls back to the label's initials. */
export function machineTag(
  config: SidebarWorkspacesConfig,
  environmentId: string,
  label?: string | null,
): string {
  return machineDisplayOf(config, environmentId, label ?? environmentId).tag;
}

export interface OfflineLogicalProject {
  readonly logicalKey: string;
  readonly environmentId: string;
  readonly path: string;
  readonly state: string | null;
  readonly updatedAt: string | null;
  readonly tag: string;
}

/**
 * Logical projects whose every representation sits on a machine this client cannot reach. A
 * project with one connected representation is already in the normal project list; excluding it
 * here prevents a duplicate greyed card.
 */
export function offlineLogicalProjects(
  config: SidebarWorkspacesConfig,
  connectedEnvironmentIds: ReadonlySet<string>,
  labelOf: (environmentId: string) => string | null = () => null,
): OfflineLogicalProject[] {
  const result: OfflineLogicalProject[] = [];
  for (const [logicalKey, reps] of Object.entries(config.projectMounts).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (reps.some((rep) => connectedEnvironmentIds.has(rep.environmentId))) continue;
    for (const rep of reps) {
      const status = config.projectMountStatus[logicalKey]?.[rep.environmentId];
      result.push({
        logicalKey,
        environmentId: rep.environmentId,
        path: rep.path,
        state: status?.state ?? null,
        updatedAt: status?.updatedAt ?? null,
        tag: machineTag(config, rep.environmentId, labelOf(rep.environmentId)),
      });
    }
  }
  return result;
}

/** Merge suggestions for one logical project, with the other environment's tag. */
export function mergeSuggestionsFor<T extends Project & { readonly title: string }>(
  config: SidebarWorkspacesConfig,
  projects: readonly T[],
  targetKey: string,
  logicalKeyOf: (project: T) => string,
  environmentLabel: (environmentId: string) => string | null = () => null,
): { readonly project: T; readonly tag: string }[] {
  const suggestions: { readonly project: T; readonly tag: string }[] = [];
  for (const group of suggestMerges(projects)) {
    if (!group.some((project) => logicalKeyOf(project) === targetKey)) continue;
    for (const project of group) {
      if (logicalKeyOf(project) === targetKey) continue;
      suggestions.push({
        project,
        tag: machineTag(config, project.environmentId, environmentLabel(project.environmentId)),
      });
    }
  }
  return suggestions;
}

export function logicalProjectTitle(
  config: SidebarWorkspacesConfig,
  id: string,
  fallback: string,
): string {
  return config.projectTitles?.[follow(id, config)]?.trim() || fallback;
}

export function renameLogicalProject(
  config: SidebarWorkspacesConfig,
  key: string,
  title: string,
  projects: readonly Project[],
): SidebarWorkspacesConfig {
  const trimmed = title.trim();
  if (!trimmed) return config;
  return {
    ...config,
    projectTitles: { ...config.projectTitles, [key]: trimmed },
    projectAliases: {
      ...config.projectAliases,
      ...Object.fromEntries(
        projects.map((project) => [
          `${project.environmentId}:${normalizeRepresentationPath(project.workspaceRoot)}`,
          key,
        ]),
      ),
    },
  };
}
