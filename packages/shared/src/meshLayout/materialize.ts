import { validateLayoutEntry } from "./registry.ts";
import { normalizeRepresentationPath } from "./representationPath.ts";
import { configFromLayout, bindingsFromLayout } from "../meshConfig/index.ts";
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
const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

export function materialize(doc: MeshLayoutDocument): SidebarWorkspacesConfig {
  const workspaces: (SidebarWorkspace & { sort: string })[] = [];
  const rules: (SidebarWorkspaceRule & { sort: string; id: string })[] = [];
  const placements: Record<string, string[]> = dictionary();
  const assignments: Record<string, string> = dictionary();
  const workspaceProjectOrder: Record<string, string[]> = dictionary();
  const workspaceFold: Record<string, Record<string, "quiet" | "active">> = dictionary();
  const machines: Record<string, SidebarMachine> = dictionary();
  const projectTitles: Record<string, string> = dictionary();
  const projectAliases: Record<string, string> = dictionary();
  const projectMounts: Record<string, SidebarProjectMount[]> = dictionary();
  const projectMountStatus: Record<
    string,
    Record<string, SidebarProjectMountStatus>
  > = dictionary();
  const orders: { id: string; sort: string }[] = [];
  const places: {
    project: string;
    workspace: string;
    sort: string;
    placed?: boolean;
    ordered?: boolean;
    placementIndex?: number;
  }[] = [];
  const legacy: Record<string, Json> = dictionary();
  for (const [key, { v }] of Object.entries(doc).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (v === null || validateLayoutEntry(key, doc[key]!) !== null) continue;
    if (key.startsWith("proj/") && key.endsWith(".title") && typeof v === "string") {
      const id = decodeURIComponent(key.slice(5, -6));
      if ((doc[keys.project(id)]?.h ?? "") <= doc[key]!.h) projectTitles[id] = v;
      continue;
    }
    const [family, a = "", b = ""] = key.split("/").map(decodeURIComponent);
    switch (family) {
      case "ws":
        workspaces.push({ ...(v as Omit<SidebarWorkspace, "id"> & { sort: string }), id: a });
        break;
      case "rule":
        rules.push({ ...(v as SidebarWorkspaceRule & { sort: string }), id: a });
        break;
      case "place":
        places.push({
          ...(v as { sort: string; placed?: boolean; ordered?: boolean }),
          project: a,
          workspace: b,
        });
        break;
      case "order":
        orders.push({ ...(v as { sort: string }), id: a });
        break;
      case "workspaceOrder":
        workspaceProjectOrder[a] = [];
        break;
      case "fold":
        (workspaceFold[a] ??= dictionary())[b] = v as "quiet" | "active";
        break;
      case "machine":
        machines[a] = v as SidebarMachine;
        break;
      case "proj":
        if (
          typeof v === "object" &&
          "title" in v &&
          typeof v.title === "string" &&
          (doc[keys.projectTitle(a)]?.h ?? "") < doc[key]!.h
        )
          projectTitles[a] = v.title;
        break;
      case "alias":
        projectAliases[a] = v as string;
        break;
      case "rep":
        (projectMounts[a] ??= []).push(v as SidebarProjectMount);
        break;
      case "repstatus":
        (projectMountStatus[a] ??= dictionary())[b] = v as SidebarProjectMountStatus;
        break;
      case "empty":
        if (a === "workspaceFold") workspaceFold[b] ??= dictionary();
        if (a === "projectMounts") projectMounts[b] ??= [];
        if (a === "projectMountStatus") projectMountStatus[b] ??= dictionary();
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
  const claims = Object.entries(projectMounts).flatMap(([logical, reps]) =>
    reps.map((rep) => ({
      logical,
      rep,
      entry: doc[keys.representation(logical, rep.environmentId)]!,
    })),
  );
  claims.sort(
    (a, b) =>
      b.entry.h.localeCompare(a.entry.h) ||
      (a.logical < b.logical ? -1 : a.logical > b.logical ? 1 : 0),
  );
  const claimed = new Set<string>();
  for (const { logical, rep } of claims) {
    const identity = JSON.stringify([rep.environmentId, normalizeRepresentationPath(rep.path)]);
    if (claimed.has(identity))
      projectMounts[logical] = projectMounts[logical]!.filter((other) => other !== rep);
    else claimed.add(identity);
  }
  const desired = configFromLayout(doc);
  if (desired)
    for (const [name, environmentId] of Object.entries(bindingsFromLayout(doc))) {
      const machine = desired.machines[name];
      if (!machine) continue;
      const aliases = Array.isArray(machine.aliases)
        ? machine.aliases.filter((alias): alias is string => typeof alias === "string")
        : undefined;
      machines[environmentId] = {
        ...machines[environmentId],
        ...(machine.title !== undefined ? { label: machine.title } : {}),
        ...(machine.label !== undefined ? { tag: machine.label } : {}),
        ...(machine.color !== undefined ? { color: machine.color } : {}),
        ...(aliases ? { aliases } : {}),
      };
    }
  return {
    ...(writers.length ? { meshWriters: writers } : {}),
    workspaces: workspaces.map(({ sort: _sort, ...w }) => w),
    rules: rules.map(({ sort: _sort, id: _id, ...r }) => r),
    assignments,
    placements,
    workspaceProjectOrder,
    workspaceFold,
    machines,
    projectTitles,
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
