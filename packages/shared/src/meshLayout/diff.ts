import type { SidebarWorkspacesConfig } from "@t3tools/contracts";
import { canonical, keys, type Json, type MeshLayoutDocument } from "./document.ts";
import { generateN } from "./fractionalIndex.ts";
import type { Hlc } from "./hlc.ts";

function sorts(
  ids: readonly string[],
  keyOf: (id: string) => string,
  doc: MeshLayoutDocument,
): Map<string, string> {
  // Longest increasing subsequence keeps the maximum number of existing sort keys.
  const paths: { id: string; sort: string }[][] = [];
  let best: { id: string; sort: string }[] = [];
  for (const id of ids) {
    const value = doc[keyOf(id)]?.v;
    const sort = value && typeof value === "object" && "sort" in value ? value.sort : null;
    if (typeof sort !== "string") continue;
    let previous: typeof best = [];
    for (const path of paths)
      if (path.at(-1)!.sort < sort && path.length > previous.length) previous = path;
    const path = [...previous, { id, sort }];
    paths.push(path);
    if (path.length > best.length) best = path;
  }
  const result = new Map(best.map((p) => [p.id, p.sort]));
  let left: string | null = null;
  for (let i = 0; i < ids.length;) {
    const kept = result.get(ids[i]!);
    if (kept !== undefined) {
      left = kept;
      i++;
      continue;
    }
    let end = i + 1;
    while (end < ids.length && !result.has(ids[end]!)) end++;
    const generated = generateN(left, end < ids.length ? result.get(ids[end]!)! : null, end - i);
    for (let j = i; j < end; j++) result.set(ids[j]!, generated[j - i]!);
    left = generated.at(-1)!;
    i = end;
  }
  return result;
}
export function encode(
  config: SidebarWorkspacesConfig,
  doc: MeshLayoutDocument = {},
): Record<string, Json> {
  const values: Record<string, Json> = {};
  for (const [id, title] of Object.entries(config.projectTitles ?? {}))
    values[keys.projectTitle(id)] = title;
  const put = (key: string, value: unknown) => {
    values[key] = JSON.parse(JSON.stringify(value)) as Json;
  };
  const ordered = (
    ids: readonly string[],
    keyOf: (id: string) => string,
    valueOf: (id: string) => object,
  ) => {
    const ranks = sorts(ids, keyOf, doc);
    for (const id of ids) put(keyOf(id), { ...valueOf(id), sort: ranks.get(id)! });
  };
  ordered(
    config.workspaces.map((w) => w.id),
    keys.workspace,
    (id) => {
      const { id: _id, ...rest } = config.workspaces.find((w) => w.id === id)!;
      return rest;
    },
  );
  const ruleIds = config.rules.map(
    (r, i) =>
      `${r.match}\0${r.workspace}\0${config.rules.slice(0, i).filter((other) => other.match === r.match && other.workspace === r.workspace).length}`,
  );
  ordered(ruleIds, keys.rule, (id) => config.rules[ruleIds.indexOf(id)]!);
  put(keys.defaultWorkspace, config.defaultWorkspace);
  put(keys.quietAfterDays, config.quietAfterDays);
  ordered(config.projectOrder, keys.order, () => ({}));
  const workspaceIds = new Set([
    ...Object.keys(config.workspaceProjectOrder),
    ...Object.values(config.placements).flat(),
    ...Object.values(config.assignments),
  ]);
  for (const ws of workspaceIds) {
    const order = config.workspaceProjectOrder[ws];
    if (order !== undefined) put(keys.workspaceOrder(ws), true);
    const placed = Object.keys({ ...config.assignments, ...config.placements }).filter((p) =>
      (config.placements[p] ?? [config.assignments[p]]).includes(ws),
    );
    const ids = [...(order ?? []), ...placed.filter((p) => !order?.includes(p))];
    ordered(
      ids,
      (p) => keys.place(p, ws),
      (p) => ({
        ...(placed.includes(p)
          ? { placementIndex: (config.placements[p] ?? [config.assignments[p]]).indexOf(ws) }
          : { placed: false }),
        ...(order?.includes(p) ? {} : { ordered: false }),
      }),
    );
  }
  for (const [ws, folds] of Object.entries(config.workspaceFold))
    for (const [p, mode] of Object.entries(folds)) put(keys.fold(ws, p), mode);
  for (const [env, machine] of Object.entries(config.machines)) put(keys.machine(env), machine);
  for (const [alias, logical] of Object.entries(config.projectAliases))
    put(keys.alias(alias), logical);
  for (const [logical, reps] of Object.entries(config.projectMounts))
    for (const rep of reps) put(keys.representation(logical, rep.environmentId), rep);
  for (const [logical, statuses] of Object.entries(config.projectMountStatus))
    for (const [env, status] of Object.entries(statuses))
      put(keys.representationStatus(logical, env), status);
  for (const field of ["alwaysShow", "alwaysQuiet"] as const)
    if (config[field].length) put(keys.legacy(field), config[field]);
  for (const field of ["workspaceFold", "projectMounts", "projectMountStatus"] as const)
    for (const [id, value] of Object.entries(config[field]))
      if (Object.keys(value).length === 0) put(keys.empty(field, id), true);
  return values;
}
export function diff(
  before: SidebarWorkspacesConfig,
  after: SidebarWorkspacesConfig,
  doc: MeshLayoutDocument,
  nextHlc: Hlc,
): MeshLayoutDocument {
  const previous = encode(before, doc),
    next = encode(after, doc);
  const candidates = new Set([...Object.keys(previous), ...Object.keys(next)]);
  if (
    ![...candidates].some(
      (key) => canonical(previous[key] ?? null) !== canonical(next[key] ?? null),
    )
  )
    return {};
  const entries: MeshLayoutDocument = {};
  for (const key of candidates) {
    const a = doc[key]?.v ?? null,
      b = next[key] ?? null;
    const changed = canonical(previous[key] ?? null) !== canonical(b);
    if (changed && canonical(a) !== canonical(b)) entries[key] = { v: b, h: nextHlc };
    else if (
      !changed &&
      a !== null &&
      b !== null &&
      typeof a === "object" &&
      typeof b === "object" &&
      !Array.isArray(a) &&
      !Array.isArray(b) &&
      "sort" in a &&
      "sort" in b &&
      a.sort !== b.sort
    ) {
      entries[key] = { v: { ...a, sort: b.sort }, h: nextHlc };
    }
  }
  for (const [key, entry] of Object.entries(doc)) {
    if (
      key.startsWith("mesh.machineBinding/") &&
      typeof entry.v === "string" &&
      Object.hasOwn(before.machines, entry.v) &&
      !Object.hasOwn(after.machines, entry.v)
    ) {
      entries[key] = { v: null, h: nextHlc };
      entries[keys.machineClaim(entry.v)] = { v: null, h: nextHlc };
    }
  }
  return entries;
}
