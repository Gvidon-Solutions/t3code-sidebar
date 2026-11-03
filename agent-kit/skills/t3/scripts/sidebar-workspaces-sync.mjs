#!/usr/bin/env node
// Copies legacy layouts; dry run by default, with backups before writes.

import * as NodeChildProcess from "node:child_process";
const { execFileSync } = NodeChildProcess;
import * as NodeFS from "node:fs";
const { mkdirSync, writeFileSync } = NodeFS;
import * as NodeOS from "node:os";
const { homedir } = NodeOS;
import * as NodePath from "node:path";
const { basename, join } = NodePath;

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
if (has("--help") || has("-h")) {
  console.log(
    "usage: sidebar-workspaces-sync.mjs [--from local|HOST] --to HOST [--apply] [--json]\n" +
      "  default: --from local, dry run; --to is required",
  );
  process.exit(0);
}
const valueOf = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) die(`${name} needs a value`);
  return v;
};
const from = valueOf("--from", "local");
const to = valueOf("--to");
if (!to) die("--to HOST is required");
const apply = has("--apply");
const asJson = has("--json");

function die(message) {
  console.error(`sidebar-workspaces-sync: ${message}`);
  process.exit(1);
}

function run(side, args, input) {
  const t3ctl = process.env.T3CTL_BIN || "t3ctl";
  if (side === "local") {
    return execFileSync(t3ctl, args, { input, encoding: "utf8", maxBuffer: 64 << 20 });
  }
  return execFileSync("ssh", [side, t3ctl, ...args], {
    input,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
}

function readSide(side) {
  const ws = JSON.parse(run(side, ["ws", "list", "--json"]));
  const projects = JSON.parse(run(side, ["projects", "--json"]));
  const roots = new Map(projects.map((p) => [p.id, p.workspaceRoot]));
  return {
    config: ws.config,
    projects: ws.projects.map((p) => ({ ...p, workspaceRoot: roots.get(p.id) })),
  };
}

const norm = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase();
const rootBase = (p) =>
  p.workspaceRoot ? norm(basename(String(p.workspaceRoot).replace(/[\\/]+$/, ""))) : "";

function index(projects) {
  const byKey = new Map();
  const byTitle = new Map();
  const byRoot = new Map();
  const add = (map, key, project) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    list.push(project);
    map.set(key, list);
  };
  for (const p of projects) {
    byKey.set(p.key, p);
    add(byTitle, norm(p.title), p);
    add(byRoot, rootBase(p), p);
  }
  return { byKey, byTitle, byRoot };
}

function matchProject(target, index) {
  if (target.key === "no-project") return "no-project";
  const exact = index.byKey.get(target.key);
  if (exact) return exact.key;
  const byTitle = index.byTitle.get(norm(target.title)) ?? [];
  if (byTitle.length === 1) return byTitle[0].key;
  const base = rootBase(target);
  const byRoot = base ? (index.byRoot.get(base) ?? []) : [];
  if (byRoot.length === 1) return byRoot[0].key;
  return null;
}

function globRe(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function sourcePlacement(cfg, wsIds, key, root, scratch) {
  const _placed = (cfg.placements?.[key] ?? []).filter((id) => wsIds.has(id));
  if (placed.length) return placed;
  if (scratch) return cfg.workspaces.map((w) => w.id);
  if (wsIds.has(cfg.assignments?.[key])) return [cfg.assignments[key]];
  for (const rule of cfg.rules ?? []) {
    if (wsIds.has(rule.workspace) && globRe(rule.match).test(root)) return [rule.workspace];
  }
  const fallback = wsIds.has(cfg.defaultWorkspace) ? cfg.defaultWorkspace : cfg.workspaces[0]?.id;
  return fallback ? [fallback] : [];
}

function diffLabels(before, after, label) {
  const beforeById = new Map(before.map((x) => [x.id, x]));
  const afterById = new Map(after.map((x) => [x.id, x]));
  const added = after.filter((x) => !beforeById.has(x.id));
  const removed = before.filter((x) => !afterById.has(x.id));
  const changed = after.filter((x) => {
    const old = beforeById.get(x.id);
    return old && JSON.stringify(old) !== JSON.stringify(x);
  });
  const parts = [];
  if (added.length) parts.push(`add ${added.map((x) => x.name).join(", ")}`);
  if (removed.length) parts.push(`remove ${removed.map((x) => x.name).join(", ")}`);
  if (changed.length) parts.push(`update ${changed.map((x) => x.name).join(", ")}`);
  return `${label}: ${parts.join("; ") || "unchanged"}`;
}

const source = readSide(from);
const target = readSide(to);
const cfg = source.config;
const wsIds = new Set(cfg.workspaces.map((w) => w.id));
const defaultWs = wsIds.has(cfg.defaultWorkspace)
  ? cfg.defaultWorkspace
  : (cfg.workspaces[0]?.id ?? null);
const sourceIndex = index(source.projects);

// Keep a target tile's id when its name matches, so clients do not see the
// same tile disappear and come back under another id.
const targetWsByName = new Map(target.config.workspaces.map((w) => [norm(w.name), w.id]));
const wsMap = new Map();
const resultWsIds = new Set();
for (const workspace of cfg.workspaces) {
  const preferred = targetWsByName.get(norm(workspace.name));
  let id = preferred && !resultWsIds.has(preferred) ? preferred : workspace.id;
  for (let n = 2; resultWsIds.has(id); n++) id = `${workspace.id}-${n}`;
  resultWsIds.add(id);
  wsMap.set(workspace.id, id);
}
const mapWsIds = (ids) => [
  ...new Set(ids.map((id) => wsMap.get(id)).filter((id) => id && resultWsIds.has(id))),
];
const mapWsId = (id) => (id && resultWsIds.has(wsMap.get(id)) ? wsMap.get(id) : null);

const keyToSource = new Map();
const sourceToKey = new Map();
for (const project of target.projects) {
  const sourceKey = matchProject(project, sourceIndex);
  if (!sourceKey) continue;
  keyToSource.set(project.key, sourceKey);
  if (!sourceToKey.has(sourceKey)) sourceToKey.set(sourceKey, project.key);
}

const sourceProjects = new Map(source.projects.map((p) => [p.key, p]));
const result = {
  workspaces: cfg.workspaces.map((w) => ({ ...structuredClone(w), id: wsMap.get(w.id) })),
  assignments: {},
  placements: {},
  rules: (cfg.rules ?? [])
    .map((rule) => ({ ...rule, workspace: mapWsId(rule.workspace) }))
    .filter((rule) => rule.workspace),
  defaultWorkspace: mapWsId(defaultWs),
  projectOrder: [],
  workspaceProjectOrder: {},
  workspaceFold: {},
  alwaysShow: [],
  alwaysQuiet: [],
  quietAfterDays: cfg.quietAfterDays ?? 5,
};

for (const [sourceKey, targetKey] of sourceToKey) {
  const project = sourceProjects.get(sourceKey);
  if (!project) continue;
  const shown = mapWsIds(
    sourcePlacement(cfg, wsIds, sourceKey, project.workspaceRoot ?? "", sourceKey === "no-project"),
  );
  if (sourceKey === "no-project" && !(cfg.placements?.[sourceKey] ?? []).length) continue;
  if (!shown.length) continue;
  result.placements[targetKey] = shown;
  result.assignments[targetKey] = shown[0];
}

for (const key of cfg.projectOrder ?? []) {
  const targetKey = sourceToKey.get(key);
  if (targetKey) result.projectOrder.push(targetKey);
}

for (const [ws, keys] of Object.entries(cfg.workspaceProjectOrder ?? {})) {
  const resultWs = mapWsId(ws);
  if (!resultWs) continue;
  const translated = keys.map((key) => sourceToKey.get(key)).filter(Boolean);
  if (translated.length) {
    result.workspaceProjectOrder[resultWs] = [
      ...new Set([...(result.workspaceProjectOrder[resultWs] ?? []), ...translated]),
    ];
  }
}

for (const [ws, projects] of Object.entries(cfg.workspaceFold ?? {})) {
  const resultWs = mapWsId(ws);
  if (!resultWs) continue;
  for (const [key, mode] of Object.entries(projects)) {
    const targetKey = sourceToKey.get(key);
    if (targetKey)
      result.workspaceFold[resultWs] = { ...result.workspaceFold[resultWs], [targetKey]: mode };
  }
}

const resultWsByName = new Map(result.workspaces.map((w) => [norm(w.name), w.id]));
const unmatched = [];
for (const project of target.projects) {
  if (project.key === "no-project" || keyToSource.has(project.key)) continue;
  unmatched.push(project);
  const current = project.workspaces ?? [];
  const shown = [
    ...new Set(
      current
        .map((id) => {
          const name = target.config.workspaces.find((w) => w.id === id)?.name;
          return resultWsByName.get(norm(name));
        })
        .filter(Boolean),
    ),
  ];
  const placement = shown.length ? shown : result.defaultWorkspace ? [result.defaultWorkspace] : [];
  if (!placement.length) continue;
  result.placements[project.key] = placement;
  result.assignments[project.key] = placement[0];
  for (const ws of placement) {
    const order = result.workspaceProjectOrder[ws];
    if (order && !order.includes(project.key)) order.push(project.key);
  }
}

const skipped = source.projects.filter((p) => p.key !== "no-project" && !sourceToKey.has(p.key));
const planned = {
  workspaces: result.workspaces,
  defaultWorkspace: result.defaultWorkspace,
  rules: result.rules,
  quietAfterDays: result.quietAfterDays,
  placements: result.placements,
  workspaceProjectOrder: result.workspaceProjectOrder,
  workspaceFold: result.workspaceFold,
};

if (asJson && !apply) {
  console.log(
    JSON.stringify(
      {
        planned,
        matched: Object.fromEntries(keyToSource),
        skipped: skipped.map((p) => p.title),
        unmatched: unmatched.map((p) => p.title),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(
  `source ${from}: ${source.config.workspaces.length} tiles, ${source.projects.length} projects`,
);
console.log(
  `target ${to}: ${target.config.workspaces.length} tiles, ${target.projects.length} projects`,
);
console.log(diffLabels(target.config.workspaces, result.workspaces, "tiles"));
console.log(
  `projects matched: ${
    [...sourceToKey.keys()].length
  } (${[...sourceToKey.keys()].slice(0, 8).join(", ")}${sourceToKey.size > 8 ? ", …" : ""})`,
);
if (skipped.length) {
  console.log(
    `source projects without a local pair (left out): ${skipped.map((p) => p.title).join(", ")}`,
  );
}
if (unmatched.length) {
  console.log(
    `local projects without a source pair (kept in a same-named tile or default): ${unmatched.map((p) => p.title).join(", ")}`,
  );
}
console.log(`default workspace: ${result.defaultWorkspace ?? "(none)"}`);

if (!apply) {
  console.log(JSON.stringify({ sidebarWorkspaces: result }, null, 2));
  console.log("\ndry run; add --apply to write this to the target");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = join(homedir(), ".local", "state", "t3-ws-sync");
mkdirSync(backupDir, { recursive: true });
const backupPath = join(backupDir, `${stamp}-${to.replace(/[^a-z0-9.-]+/gi, "_")}.json`);
writeFileSync(
  backupPath,
  JSON.stringify(
    { host: to, takenAt: new Date().toISOString(), sidebarWorkspaces: target.config },
    null,
    2,
  ),
);
console.log(`backup: ${backupPath}`);

try {
  run(to, ["settings", "set", "-"], JSON.stringify({ sidebarWorkspaces: result }));
  const after = readSide(to);
  const sameTiles = JSON.stringify(after.config.workspaces) === JSON.stringify(result.workspaces);
  const bad = [];
  for (const project of after.projects) {
    const expected = result.placements[project.key];
    if (!expected) continue;
    const got = [...(project.workspaces ?? [])].sort();
    if (JSON.stringify(got) !== JSON.stringify([...expected].sort())) {
      bad.push(`${project.title}: ${got.join(",")} != ${expected.join(",")}`);
    }
  }
  if (!sameTiles || bad.length) {
    throw new Error(
      `verification failed${sameTiles ? "" : " (tiles differ)"}${bad.length ? `: ${bad.join("; ")}` : ""}`,
    );
  }
  console.log(`applied and verified: ${after.config.workspaces.length} tiles`);
  for (const project of after.projects) {
    const names = (project.workspaces ?? [])
      .map((id) => result.workspaces.find((w) => w.id === id)?.name ?? id)
      .join(", ");
    console.log(`  ${project.title}: ${names}`);
  }
} catch (error) {
  console.error(`sidebar-workspaces-sync: ${error.message}`);
  console.error(`restoring ${to} from ${backupPath}`);
  run(to, ["settings", "set", "-"], JSON.stringify({ sidebarWorkspaces: target.config }));
  process.exit(1);
}
