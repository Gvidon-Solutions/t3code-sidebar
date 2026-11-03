import { normalizeProjectPathForComparison } from "../path.ts";
import { meshAuthorityOf } from "./authority.ts";
import { keys } from "./document.ts";
import type {
  SidebarWorkspacesConfig,
  SidebarWorkspace,
  SidebarWorkspaceRule,
  SidebarMachine,
  SidebarProjectMount,
  SidebarProjectMountStatus,
} from "@t3tools/contracts";
import type { Json, MeshLayoutDocument } from "./document.ts";
export function materialize(doc: MeshLayoutDocument): SidebarWorkspacesConfig {
  const projectTitles: Record<string, string> = {};
  const workspaces: (SidebarWorkspace & { sort: string })[] = [];
  const rules: (SidebarWorkspaceRule & { sort: string; id: string })[] = [];
  const placements: Record<string, string[]> = {};
  const assignments: Record<string, string> = {};
  const workspaceProjectOrder: Record<string, string[]> = {};
  const workspaceFold: Record<string, Record<string, "quiet" | "active">> = {};
  const machines: Record<string, SidebarMachine> = {};
  const projectAliases: Record<string, string> = {};
  const projectMounts: Record<string, SidebarProjectMount[]> = {};
  const projectMountStatus: Record<string, Record<string, SidebarProjectMountStatus>> = {};
  const orders: { id: string; sort: string }[] = [];
  const places: {
    project: string;
    workspace: string;
    sort: string;
    placed?: boolean;
    ordered?: boolean;
    placementIndex?: number;
  }[] = [];
  const legacy: Record<string, Json> = {};
  for (const [key, { v }] of Object.entries(doc).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (v === null) continue;
    if (key.startsWith("proj/") && key.endsWith(".title") && typeof v === "string") {
      projectTitles[decodeURIComponent(key.slice(5, -6))] = v;
      continue;
    }
    const [family, a = "", b = ""] = key.split("/").map(decodeURIComponent);
    switch (family) {
      case "ws":
        workspaces.push({ id: a, ...(v as Omit<SidebarWorkspace, "id"> & { sort: string }) });
        break;
      case "rule":
        rules.push({ id: a, ...(v as SidebarWorkspaceRule & { sort: string }) });
        break;
      case "place":
        places.push({
          project: a,
          workspace: b,
          ...(v as { sort: string; placed?: boolean; ordered?: boolean }),
        });
        break;
      case "order":
        orders.push({ id: a, ...(v as { sort: string }) });
        break;
      case "workspaceOrder":
        workspaceProjectOrder[a] = [];
        break;
      case "fold":
        (workspaceFold[a] ??= {})[b] = v as "quiet" | "active";
        break;
      case "machine":
        machines[a] = v as SidebarMachine;
        break;
      case "alias":
        projectAliases[a] = v as string;
        break;
      case "rep":
        (projectMounts[a] ??= []).push(v as SidebarProjectMount);
        break;
      case "repstatus":
        (projectMountStatus[a] ??= {})[b] = v as SidebarProjectMountStatus;
        break;
      case "empty":
        if (a === "workspaceFold") workspaceFold[b] ??= {};
        if (a === "projectMounts") projectMounts[b] ??= [];
        if (a === "projectMountStatus") projectMountStatus[b] ??= {};
        break;
      case "legacy":
        legacy[a] = v;
        break;
    }
  }
  const ordered = <T extends { sort: string }>(items: T[]) =>
    items.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  ordered(workspaces);
  ordered(rules);
  ordered(orders);
  ordered(places);
  for (const p of places) {
    if (p.placed !== false) (placements[p.project] ??= []).push(p.workspace);
    if (p.ordered !== false) (workspaceProjectOrder[p.workspace] ??= []).push(p.project);
  }
  const rank = new Map(workspaces.map((w, i) => [w.id, i]));
  const placementRank = new Map(
    places.map((p) => [JSON.stringify([p.project, p.workspace]), p.placementIndex]),
  );
  for (const [project, ids] of Object.entries(placements)) {
    ids.sort(
      (a, b) =>
        (placementRank.get(JSON.stringify([project, a])) ?? rank.get(a) ?? Infinity) -
          (placementRank.get(JSON.stringify([project, b])) ?? rank.get(b) ?? Infinity) ||
        (a < b ? -1 : a > b ? 1 : 0),
    );
    assignments[project] = ids[0]!;
  }
  const writers = [
    ...new Set(
      Object.keys(doc)
        .filter((key) => key.startsWith("writer/"))
        .map((key) => decodeURIComponent(key.slice(7))),
    ),
  ].sort();
  const authority = meshAuthorityOf({
    meshWriters: writers,
    ...(typeof doc["mesh.authority"]?.v === "string"
      ? { meshAuthority: doc["mesh.authority"].v }
      : {}),
  });
  const claims = Object.entries(projectMounts).flatMap(([logical, reps]) =>
    reps.map((rep) => ({
      logical,
      rep,
      entry: doc[keys.representation(logical, rep.environmentId)]!,
    })),
  );
  claims.sort(
    (a, b) =>
      Number(b.entry.h.slice(20) === authority) - Number(a.entry.h.slice(20) === authority) ||
      (a.logical < b.logical ? -1 : a.logical > b.logical ? 1 : 0),
  );
  const claimed = new Set<string>();
  for (const { logical, rep } of claims) {
    const identity = JSON.stringify([
      rep.environmentId,
      normalizeProjectPathForComparison(rep.path),
    ]);
    if (claimed.has(identity))
      projectMounts[logical] = projectMounts[logical]!.filter((other) => other !== rep);
    else claimed.add(identity);
  }
  return {
    ...(typeof doc["mesh.authority"]?.v === "string"
      ? { meshAuthority: doc["mesh.authority"].v }
      : {}),
    ...(Object.keys(projectTitles).length ? { projectTitles } : {}),
    ...(writers.length ? { meshWriters: writers } : {}),
    workspaces: workspaces.map(({ sort: _sort, ...w }) => w),
    rules: rules.map(({ sort: _sort, id: _id, ...r }) => r),
    assignments,
    placements,
    workspaceProjectOrder,
    workspaceFold,
    machines,
    projectAliases,
    projectMounts,
    projectMountStatus,
    defaultWorkspace: (doc["ws.default"]?.v as string | null) ?? null,
    quietAfterDays: (doc["ws.quietAfterDays"]?.v as number) ?? 5,
    projectOrder: orders.map((o) => o.id),
    alwaysShow: (legacy.alwaysShow as string[]) ?? [],
    alwaysQuiet: (legacy.alwaysQuiet as string[]) ?? [],
  };
}
