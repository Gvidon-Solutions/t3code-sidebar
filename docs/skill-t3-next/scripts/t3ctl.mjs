#!/usr/bin/env node
// Uses MCP for agent tools and WebSocket RPC for UI operations.
// Nothing reads the server's sqlite; nothing here restarts the server except `server restart`.
import * as NodeChildProcess from "node:child_process";
const { execFileSync, spawnSync } = NodeChildProcess;
import * as NodeCrypto from "node:crypto";
const { createHash, randomBytes, randomUUID } = NodeCrypto;
import * as NodeFS from "node:fs";
const {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
} = NodeFS;
import * as NodeOS from "node:os";
const { homedir } = NodeOS;
import * as NodePath from "node:path";
const { basename, join, resolve } = NodePath;
import * as NodeURL from "node:url";
const { pathToFileURL } = NodeURL;

if (typeof WebSocket === "undefined") {
  console.error(
    `t3ctl: needs Node 22+ (global WebSocket); this is ${process.version}. Set T3CTL_NODE or put a newer node first on PATH.`,
  );
  process.exit(1);
}

// server builds the whole selftest (scripts/selftest.sh) passed on
const TESTED_VERSIONS = ["0.0.45-sidebar.14", "0.0.45-sidebar.16", "0.0.45-sidebar.17", "0.1.5"];
const TESTED_VERSION = TESTED_VERSIONS[TESTED_VERSIONS.length - 1];
const HOME = process.env.T3CODE_HOME || join(homedir(), ".t3-sidebar-server");
const USERDATA = join(HOME, "userdata");
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "t3ctl");
const UNIT = process.env.T3CTL_UNIT || "t3code-sidebar.service";
const DEFAULTS = {
  agent: process.env.T3CTL_AGENT || "claude",
  codexModel: process.env.T3CTL_CODEX_MODEL || "gpt-6-luna",
  claudeModel: process.env.T3CTL_CLAUDE_MODEL || "claude-opus-5-5",
  mode: process.env.T3CTL_MODE || "full-access",
};
const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"];
const AGENT_ALIASES = {
  claude: "claudeAgent",
  claudeagent: "claudeAgent",
  opus: "claudeAgent",
  sonnet: "claudeAgent",
  fable: "claudeAgent",
  haiku: "claudeAgent",
  deepseek: "opencode",
  1017: "opencode",
};
const MODEL_ALIASES = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  fable: "claude-fable-5-1",
  haiku: "claude-haiku-5-5",
  luna: "gpt-6-luna",
  astra: "gpt-6-astra",
  sol: "gpt-6.1-sol",
  deepseek: "deepseek/deepseek-flash",
  1017: "deepseek/deepseek-flash",
};

// flags that never take a value, so `--queue "text"` keeps "text" as the message
const DURATION_ARG = /^\d+(?:\.\d+)?(?:s|m|h|d|w)?$/;
const BOOL_FLAGS = new Set([
  "all",
  "primary",
  "dryRun",
  "apply",
  "probe",
  "raw",
  "waiting",
  "notWaiting",
  "closed",
  "dismissed",
  "queue",
  "steer",
  "restart",
  "wait",
  "json",
  "yes",
  "force",
  "full",
  "activity",
  "archived",
  "settled",
  "snoozed",
  "subagents",
  "plan",
  "scratch",
  "fast",
  "mkdir",
  "fromOrigin",
  "remote",
  "first",
  "auto",
  "add",
  "help",
]);
export function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replace(/-([a-z])/g, (_, c) =>
        c.toUpperCase(),
      );
      // `--wait [dur]` keeps a following message ("--wait \"Reply with…\"") while accepting 90, 30s, 2m.
      let val =
        eq > 0
          ? a.slice(eq + 1)
          : BOOL_FLAGS.has(key)
            ? key === "wait" && argv[i + 1] !== undefined && DURATION_ARG.test(argv[i + 1])
              ? argv[++i]
              : true
            : argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")
              ? argv[++i]
              : true;
      if (key === "opt" || key === "attach" || key === "from") val = [...(opt[key] || []), val];
      opt[key] = val;
    } else pos.push(a);
  }
  return { pos, opt };
}

class Fail extends Error {}
const die = (msg) => {
  throw new Fail(msg);
};
const json = (v) => console.log(JSON.stringify(v, null, 2));
const short = (id) => {
  const s = String(id);
  const parts = s.split(":").filter((x) => x !== "fork");
  const last = parts[parts.length - 1];
  return /^[0-9a-f-]{8,}$/i.test(last) ? last.slice(0, 8) : s.slice(0, 20);
};
const ago = (iso) => {
  if (!iso) return "-";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const clip = (s, n) => {
  s = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const expandHome = (p) => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));

function readMessage(pos, opt) {
  if (opt.file) return readFileSync(expandHome(opt.file), "utf8");
  const text = pos.join(" ");
  if (text === "-" || (!text && !process.stdin.isTTY)) return readFileSync(0, "utf8");
  return text;
}

function readJsonArg(arg) {
  if (arg === undefined || arg === "") return {};
  if (arg === "-") return JSON.parse(readFileSync(0, "utf8"));
  if (String(arg).startsWith("@"))
    return JSON.parse(readFileSync(expandHome(arg.slice(1)), "utf8"));
  try {
    return JSON.parse(arg);
  } catch (e) {
    die(`invalid JSON argument: ${e.message}`);
  }
}

function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/.exec(String(s).trim());
  if (!m) die(`bad duration "${s}" (use 30s, 10m, 2h, 1d, 1w)`);
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2]];
}

// Voice and chat name machines in Russian ("на горе", "опералия") as well as by id, label, tag
// or ssh alias. The table is deliberately small; labels and tags cover everything else.
const MACHINE_ALIASES = new Map([
  ["гвидон", "gvidon"],
  ["гвидона", "gvidon"],
  ["гвидоне", "gvidon"],
  ["гвидону", "gvidon"],
  ["гор", "gor"],
  ["гора", "gor"],
  ["горе", "gor"],
  ["гору", "gor"],
  ["гором", "gor"],
  ["опералия", "operalia"],
  ["опералии", "operalia"],
  ["опералию", "operalia"],
  ["опералией", "operalia"],
  ["оп", "operalia"],
  ["opera", "operalia"],
]);
const TRANSLIT = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};
export function normalizeMachineName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9а-я]+/gi, "");
}
function transliterateRu(value) {
  return [...value].map((c) => TRANSLIT[c] ?? c).join("");
}
/** Every spelling the resolver should try for one user-supplied machine name. */
export function machineNameVariants(value) {
  const normalized = normalizeMachineName(value);
  if (!normalized) return [];
  const variants = new Set([normalized, transliterateRu(normalized)]);
  const alias = MACHINE_ALIASES.get(normalized);
  if (alias) {
    variants.add(alias);
    variants.add(transliterateRu(alias));
  }
  // "на горе", "on gor", "machine gor" → the bare name.
  const stripped = normalized.replace(/^(?:на|on|в|vo|machine|машина)/, "");
  if (stripped.length >= 2 && stripped !== normalized) {
    variants.add(stripped);
    variants.add(transliterateRu(stripped));
    const strippedAlias = MACHINE_ALIASES.get(stripped);
    if (strippedAlias) variants.add(strippedAlias);
  }
  return [...variants].filter(Boolean);
}
export function defaultMachineTag(label, environmentId) {
  const letter = /[\p{L}\p{N}]/u;
  const fromLabel = [...String(label ?? "")].filter((c) => letter.test(c));
  const fromId = [...String(environmentId ?? "")].filter((c) => letter.test(c));
  return (fromLabel.length ? fromLabel : fromId).slice(0, 2).join("").toUpperCase() || "?";
}
const machineFieldValues = (machine) =>
  [
    machine.environmentId,
    machine.label,
    machine.tag,
    machine.linkLabel,
    machine.serverLabel,
    machine.sshAlias,
    ...(machine.aliases ?? []),
  ].filter((v) => v !== undefined && v !== null && String(v).trim() !== "");
/**
 * Resolves a machine by environment id or prefix, layout label, tag, server label, ssh alias, or
 * a Russian name. `machines` is the list `collectMachines` returns.
 */
export function resolveMachineRef(ref, machines) {
  if (ref === undefined || ref === null || String(ref).trim() === "") {
    die(
      `a machine is required. Known: ${machines.map((m) => `${m.label} (${m.tag})`).join(", ") || "none"}`,
    );
  }
  const raw = String(ref).trim();
  const lower = raw.toLowerCase();
  const exactEnv = machines.filter((m) => m.environmentId.toLowerCase() === lower);
  if (exactEnv.length === 1) return exactEnv[0];
  const prefixEnv =
    raw.length >= 4
      ? machines.filter(
          (m) =>
            m.environmentId.toLowerCase().startsWith(lower) ||
            short(m.environmentId).toLowerCase() === lower ||
            short(m.environmentId).toLowerCase().startsWith(lower),
        )
      : [];
  if (prefixEnv.length === 1) return prefixEnv[0];
  if (prefixEnv.length > 1) {
    die(
      `"${ref}" matches ${prefixEnv.length} machines: ${prefixEnv.map((m) => `${m.label} ${m.environmentId}`).join(", ")}; use more of the id`,
    );
  }
  const variants = machineNameVariants(raw);
  let best = [];
  let bestScore = 0;
  for (const machine of machines) {
    let score = 0;
    for (const value of machineFieldValues(machine)) {
      const candidates = new Set([
        normalizeMachineName(value),
        transliterateRu(normalizeMachineName(value)),
      ]);
      for (const variant of variants) {
        if (candidates.has(variant)) score = Math.max(score, 3);
        else if (variant.length >= 3 && [...candidates].some((c) => c.startsWith(variant)))
          score = Math.max(score, 2);
        else if (variant.length >= 3 && [...candidates].some((c) => c.includes(variant)))
          score = Math.max(score, 1);
      }
    }
    if (score > bestScore) {
      best = [machine];
      bestScore = score;
    } else if (score > 0 && score === bestScore) best.push(machine);
  }
  if (best.length === 1) return best[0];
  if (best.length > 1) {
    die(
      `"${ref}" matches ${best.length} machines: ${best.map((m) => `${m.label} (${m.tag}, ${short(m.environmentId)})`).join(", ")}; be more specific`,
    );
  }
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(raw))
    return { environmentId: raw, label: raw, tag: defaultMachineTag(raw, raw) };
  die(
    `no machine "${ref}". Known: ${machines.map((m) => `${m.label} (${m.tag}, ${short(m.environmentId)})`).join(", ") || "none"}`,
  );
}

export function waitSeconds(value) {
  if (value === undefined || value === false) return undefined;
  if (value === true) return 600;
  const text = String(value).trim();
  const seconds = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : parseDuration(text) / 1000;
  return Math.max(0, Math.min(600, Math.round(seconds)));
}
export function buildPlaceInput({ project, machine, role, source, path, wait, action }) {
  return {
    project,
    machine,
    ...(action ? { action } : {}),
    ...(role ? { role } : {}),
    ...(source ? { source } : {}),
    ...(path ? { path } : {}),
    ...(wait !== undefined ? { wait } : {}),
  };
}
export function buildMeshLinkInput({
  url,
  pairingCode,
  environmentId,
  label,
  access = "full-access",
  alternateUrls,
}) {
  return {
    url,
    pairingCode,
    access,
    ...(environmentId ? { expectedEnvironmentId: environmentId } : {}),
    ...(label ? { expectedLabel: label } : {}),
    ...(alternateUrls?.length ? { alternateUrls } : {}),
  };
}
export function buildUiOpenTarget({
  kind,
  threadId,
  environmentId,
  path,
  line,
  workspace,
  issueId,
}) {
  if (kind === "thread")
    return { kind: "thread", threadId, ...(environmentId ? { environmentId } : {}) };
  if (kind === "file")
    return {
      kind: "file",
      path,
      ...(line ? { line } : {}),
      ...(environmentId ? { environmentId } : {}),
    };
  if (kind === "workspace") return { kind: "workspace", workspace };
  if (kind === "inbox") return { kind: "inbox", ...(issueId ? { issueId } : {}) };
  return { kind };
}
export function threadDeepLink(environmentId, threadId) {
  return `t3-thread://v2/${environmentId}/${threadId}`;
}
export function threadWebUrl(origin, environmentId, threadId) {
  return `${String(origin).replace(/\/$/, "")}/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}
export function fileDeepLink(environmentId, path, line) {
  return `t3-file://${encodeURIComponent(environmentId)}/${encodeURIComponent(line ? `${path}:${line}` : path)}`;
}

// The server turns entries with a zero HLC into an `adoptLegacy` merge, so migration can send a
// legacy config's entries through meshLayout.apply without a server-side migration RPC.
const FRACTION_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function validFraction(key) {
  if (
    key !== null &&
    (!key || key.endsWith("0") || [...key].some((c) => !FRACTION_DIGITS.includes(c)))
  ) {
    throw new Error("Invalid fractional index");
  }
}
export function fractionalBetween(a, b) {
  validFraction(a);
  validFraction(b);
  if (a !== null && b !== null && a >= b) throw new Error("Unordered bounds");
  let prefix = "";
  for (let i = 0; ; i++) {
    const lo = a && i < a.length ? FRACTION_DIGITS.indexOf(a[i]) : 0;
    const hi = b !== null && i < b.length ? FRACTION_DIGITS.indexOf(b[i]) : 62;
    if (hi - lo > 1) return prefix + FRACTION_DIGITS[Math.floor((lo + hi) / 2)];
    prefix += FRACTION_DIGITS[lo];
    if (lo < hi) b = null;
  }
}
export function fractionalGenerateN(a, b, count) {
  if (!Number.isInteger(count) || count < 0) throw new Error("Invalid count");
  if (!count) return [];
  const left = Math.floor(count / 2);
  const middle = fractionalBetween(a, b);
  return [
    ...fractionalGenerateN(a, middle, left),
    middle,
    ...fractionalGenerateN(middle, b, count - left - 1),
  ];
}
const MESH_KEYS = {
  workspace: (id) => `ws/${encodeURIComponent(id)}`,
  defaultWorkspace: "ws.default",
  quietAfterDays: "ws.quietAfterDays",
  rule: (id) => `rule/${encodeURIComponent(id)}`,
  place: (project, workspace) =>
    `place/${encodeURIComponent(project)}/${encodeURIComponent(workspace)}`,
  order: (project) => `order/${encodeURIComponent(project)}`,
  fold: (workspace, project) =>
    `fold/${encodeURIComponent(workspace)}/${encodeURIComponent(project)}`,
  alias: (key) => `alias/${encodeURIComponent(key)}`,
  representation: (logical, env) => `rep/${encodeURIComponent(logical)}/${encodeURIComponent(env)}`,
  representationStatus: (logical, env) =>
    `repstatus/${encodeURIComponent(logical)}/${encodeURIComponent(env)}`,
  machine: (env) => `machine/${encodeURIComponent(env)}`,
  workspaceOrder: (id) => `workspaceOrder/${encodeURIComponent(id)}`,
  empty: (field, id) => `empty/${encodeURIComponent(field)}/${encodeURIComponent(id)}`,
  legacy: (field) => `legacy/${encodeURIComponent(field)}`,
};
function meshSorts(ids, keyOf, doc) {
  const paths = [];
  let best = [];
  for (const id of ids) {
    const value = doc[keyOf(id)]?.v;
    const sort = value && typeof value === "object" && "sort" in value ? value.sort : null;
    if (typeof sort !== "string") continue;
    let previous = [];
    for (const path of paths)
      if (path.at(-1).sort < sort && path.length > previous.length) previous = path;
    const path = [...previous, { id, sort }];
    paths.push(path);
    if (path.length > best.length) best = path;
  }
  const result = new Map(best.map((p) => [p.id, p.sort]));
  let left = null;
  for (let i = 0; i < ids.length;) {
    const kept = result.get(ids[i]);
    if (kept !== undefined) {
      left = kept;
      i++;
      continue;
    }
    let end = i + 1;
    while (end < ids.length && !result.has(ids[end])) end++;
    const generated = fractionalGenerateN(
      left,
      end < ids.length ? result.get(ids[end]) : null,
      end - i,
    );
    for (let j = i; j < end; j++) result.set(ids[j], generated[j - i]);
    left = generated.at(-1);
    i = end;
  }
  return result;
}
/** `encode(config)`: the same entry set `@t3tools/shared/meshLayout` produces. */
export function encodeLegacyEntries(config, doc = {}) {
  const values = {};
  const put = (key, value) => {
    values[key] = JSON.parse(JSON.stringify(value));
  };
  const ordered = (ids, keyOf, valueOf) => {
    const ranks = meshSorts(ids, keyOf, doc);
    for (const id of ids) put(keyOf(id), { ...valueOf(id), sort: ranks.get(id) });
  };
  ordered(
    (config.workspaces ?? []).map((w) => w.id),
    MESH_KEYS.workspace,
    (id) => {
      const { id: _id, ...rest } = config.workspaces.find((w) => w.id === id);
      return rest;
    },
  );
  const rules = config.rules ?? [];
  const ruleIds = rules.map(
    (r, i) =>
      `${r.match}\0${r.workspace}\0${rules.slice(0, i).filter((other) => other.match === r.match && other.workspace === r.workspace).length}`,
  );
  ordered(ruleIds, MESH_KEYS.rule, (id) => rules[ruleIds.indexOf(id)]);
  put(MESH_KEYS.defaultWorkspace, config.defaultWorkspace);
  put(MESH_KEYS.quietAfterDays, config.quietAfterDays);
  ordered(config.projectOrder ?? [], MESH_KEYS.order, () => ({}));
  const workspaceIds = new Set([
    ...Object.keys(config.workspaceProjectOrder ?? {}),
    ...Object.values(config.placements ?? {}).flat(),
    ...Object.values(config.assignments ?? {}),
  ]);
  for (const ws of workspaceIds) {
    const order = config.workspaceProjectOrder?.[ws];
    if (order !== undefined) put(MESH_KEYS.workspaceOrder(ws), true);
    const placed = Object.keys({ ...config.assignments, ...config.placements }).filter((p) =>
      (config.placements?.[p] ?? [config.assignments[p]]).includes(ws),
    );
    const ids = [...(order ?? []), ...placed.filter((p) => !order?.includes(p))];
    ordered(
      ids,
      (p) => MESH_KEYS.place(p, ws),
      (p) => ({
        ...(placed.includes(p)
          ? { placementIndex: (config.placements?.[p] ?? [config.assignments[p]]).indexOf(ws) }
          : { placed: false }),
        ...(order?.includes(p) ? {} : { ordered: false }),
      }),
    );
  }
  for (const [ws, folds] of Object.entries(config.workspaceFold ?? {}))
    for (const [p, mode] of Object.entries(folds)) put(MESH_KEYS.fold(ws, p), mode);
  for (const [env, machine] of Object.entries(config.machines ?? {}))
    put(MESH_KEYS.machine(env), machine);
  for (const [alias, logical] of Object.entries(config.projectAliases ?? {}))
    put(MESH_KEYS.alias(alias), logical);
  for (const [logical, reps] of Object.entries(config.projectMounts ?? {}))
    for (const rep of reps) put(MESH_KEYS.representation(logical, rep.environmentId), rep);
  for (const [logical, statuses] of Object.entries(config.projectMountStatus ?? {}))
    for (const [env, status] of Object.entries(statuses))
      put(MESH_KEYS.representationStatus(logical, env), status);
  for (const field of ["alwaysShow", "alwaysQuiet"])
    if (config[field]?.length) put(MESH_KEYS.legacy(field), config[field]);
  for (const field of ["workspaceFold", "projectMounts", "projectMountStatus"])
    for (const [id, value] of Object.entries(config[field] ?? {}))
      if (Object.keys(value).length === 0) put(MESH_KEYS.empty(field, id), true);
  return values;
}
/** Entries with a zero HLC, which make the server reconcile workspace names via `adoptLegacy`. */
export function importLegacyEntries(config, environmentId) {
  const h = `0000000000000.00000.${environmentId}`;
  return Object.fromEntries(
    Object.entries(encodeLegacyEntries(config)).map(([key, v]) => [key, { v, h }]),
  );
}

function serverInfo() {
  if (process.env.T3CTL_ORIGIN) return { origin: process.env.T3CTL_ORIGIN.replace(/\/$/, "") };
  const f = join(USERDATA, "server-runtime.json");
  if (!existsSync(f))
    die(`T3 server is not running (no ${f}). Check: systemctl --user status ${UNIT}`);
  const info = JSON.parse(readFileSync(f, "utf8"));
  try {
    process.kill(info.pid, 0);
  } catch {
    die(`T3 server (pid ${info.pid}) is not running. Check: systemctl --user status ${UNIT}`);
  }
  return info;
}

// The t3 CLI of the runtime the server unit runs (never a newer one: it could migrate the live DB).
function t3bin() {
  if (process.env.T3CTL_T3_BIN) return process.env.T3CTL_T3_BIN;
  try {
    const unit = execFileSync("systemctl", ["--user", "cat", UNIT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /^ExecStart=(\S+\/runtime\/versions\/[^/]+\/t3)\s/m.exec(unit);
    if (m) {
      const bin = m[1].replace(/^%h/, homedir());
      if (existsSync(bin)) return bin;
    }
  } catch {
    /* no unit: fall back to PATH */
  }
  return "t3";
}

function t3cli(args) {
  const bin = t3bin();
  const r = spawnSync(bin, [...args, "--base-dir", HOME], {
    encoding: "utf8",
    env: { ...process.env, T3CODE_HOME: HOME },
  });
  if (r.error) die(`cannot run "${bin}": ${r.error.message}`);
  if (r.status !== 0)
    die(
      `${bin} ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout).trim().split("\n").pop()}`,
    );
  return r.stdout;
}

const tokenFile = (origin) =>
  join(CONFIG_DIR, `mcp-${new URL(origin).host.replace(/[^a-z0-9.-]/gi, "_")}.json`);

async function httpJson(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  if (!r.ok)
    die(`${init?.method || "GET"} ${new URL(url).pathname} → HTTP ${r.status}: ${clip(text, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function login(origin, { quiet } = {}) {
  const out = t3cli([
    "auth",
    "pairing",
    "create",
    "--ttl",
    "5m",
    "--label",
    "t3ctl-login",
    "--json",
  ]);
  const pair = JSON.parse(out.slice(out.indexOf("{")));
  const meta = await httpJson(`${origin}/.well-known/oauth-protected-resource/mcp`);
  const redirect = "http://127.0.0.1:1/t3ctl-callback";
  const client = await httpJson(`${origin}/oauth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "t3ctl", redirect_uris: [redirect] }),
  });
  const verifier = randomBytes(32).toString("base64url");
  const authorization = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: randomBytes(8).toString("hex"),
    resource: meta.resource,
  };
  const decision = await httpJson(`${origin}/oauth/mcp/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      authorization,
      decision: { _tag: "pairing-code", access: "full-access", code: pair.credential },
    }),
  });
  const code = new URL(decision.redirectTo).searchParams.get("code");
  if (!code) die(`approval did not return a code: ${decision.redirectTo}`);
  const tok = await httpJson(`${origin}/oauth/mcp/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: meta.resource,
    }),
  });
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const saved = {
    origin,
    resource: meta.resource,
    accessToken: tok.access_token,
    scope: tok.scope,
    expiresAt: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
    obtainedAt: new Date().toISOString(),
  };
  writeFileSync(tokenFile(origin), JSON.stringify(saved, null, 2), { mode: 0o600 });
  if (!quiet)
    console.error(
      `t3ctl: signed in to ${origin} as MCP client (full-access) until ${saved.expiresAt}`,
    );
  return saved;
}

async function loadToken(origin) {
  const f = tokenFile(origin);
  if (existsSync(f)) {
    const t = JSON.parse(readFileSync(f, "utf8"));
    if (Date.parse(t.expiresAt) - Date.now() > 3 * 864e5) return t;
  }
  return login(origin, { quiet: true });
}

class Mcp {
  constructor(origin) {
    this.origin = origin;
    this.seq = 0;
  }
  async post(body, retried) {
    const r = await fetch(this.token.resource, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token.accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sid ? { "mcp-session-id": this.sid } : {}),
      },
      body: JSON.stringify(body),
    });
    if (r.status === 401 && !retried) {
      this.token = await login(this.origin, { quiet: true });
      this.sid = undefined;
      if (body.method !== "initialize") await this.init();
      return this.post(body, true);
    }
    this.sid = r.headers.get("mcp-session-id") ?? this.sid;
    const text = await r.text();
    if (body.id === undefined) return null;
    if (!r.ok) die(`MCP ${body.method} → HTTP ${r.status}: ${clip(text, 300)}`);
    const msg = (r.headers.get("content-type") || "").includes("event-stream")
      ? text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => JSON.parse(l.slice(5)))
          .find((m) => m.id === body.id)
      : JSON.parse(text);
    if (!msg) die(`MCP ${body.method}: empty response`);
    if (msg.error) die(`MCP ${body.method}: ${msg.error.message}`);
    return msg.result;
  }
  async init() {
    this.token ??= await loadToken(this.origin);
    this.server = await this.post({
      jsonrpc: "2.0",
      id: ++this.seq,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t3ctl", version: TESTED_VERSION },
      },
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    return this;
  }
  async tools() {
    return (await this.post({ jsonrpc: "2.0", id: ++this.seq, method: "tools/list", params: {} }))
      .tools;
  }
  async callRaw(name, args = {}) {
    return this.post({
      jsonrpc: "2.0",
      id: ++this.seq,
      method: "tools/call",
      params: { name, arguments: args },
    });
  }
  async call(name, args = {}) {
    const res = await this.callRaw(name, args);
    const text = (res.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (res.isError) die(`${name}: ${clip(text, 1500)}`);
    if (res.structuredContent !== undefined) return res.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

let mcpClient;
async function mcp() {
  if (!mcpClient) mcpClient = await new Mcp(serverInfo().origin).init();
  return mcpClient;
}

async function connectWs() {
  const { origin } = serverInfo();
  const token = t3cli([
    "auth",
    "session",
    "issue",
    "--ttl",
    "10m",
    "--label",
    "t3ctl",
    "--token-only",
  ])
    .trim()
    .split("\n")
    .pop()
    .trim();
  const res = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) die(`websocket ticket request failed: HTTP ${res.status}`);
  const { ticket } = await res.json();
  const ws = new WebSocket(
    `${origin.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}&orchestrationProtocol=2&clientSurface=cli`,
  );
  const pending = new Map();
  let seq = 0;
  ws.onmessage = (e) => {
    for (const line of String(e.data).split("\n")) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m._tag === "Ping") {
        ws.send(JSON.stringify({ _tag: "Pong" }));
        continue;
      }
      const p = pending.get(m.requestId);
      if (!p) continue;
      if (m._tag === "Chunk") {
        p.chunks.push(...m.values);
        if (p.firstChunk) {
          pending.delete(m.requestId);
          ws.send(JSON.stringify({ _tag: "Interrupt", requestId: m.requestId }));
          p.resolve({ _tag: "Success", value: p.chunks });
        } else ws.send(JSON.stringify({ _tag: "Ack", requestId: m.requestId }));
      } else if (m._tag === "Exit") {
        pending.delete(m.requestId);
        p.resolve(
          p.chunks.length && m.exit._tag === "Success" ? { ...m.exit, value: p.chunks } : m.exit,
        );
      } else if (m._tag === "Defect") {
        pending.delete(m.requestId);
        p.reject(new Fail(`RPC defect: ${clip(JSON.stringify(m.defect), 800)}`));
      }
    }
  };
  await new Promise((ok, bad) => {
    ws.onopen = ok;
    ws.onerror = () => bad(new Fail("websocket connection failed"));
  });
  return {
    async rpc(tag, payload = {}, { firstChunk = false } = {}) {
      const id = String(seq++);
      const exit = await new Promise((resolve2, reject) => {
        pending.set(id, { resolve: resolve2, reject, chunks: [], firstChunk });
        ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      });
      if (exit._tag !== "Success")
        die(`${tag} failed: ${clip(JSON.stringify(exit.cause ?? exit), 1500)}`);
      return exit.value;
    },
    dispatch(cmd) {
      return this.rpc("orchestration.dispatchCommand", { commandId: randomUUID(), ...cmd });
    },
    close() {
      ws.close();
    },
  };
}

async function withWs(fn) {
  const c = await connectWs();
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

const EMPTY_LAYOUT = {
  workspaces: [],
  assignments: {},
  placements: {},
  rules: [],
  defaultWorkspace: null,
  projectOrder: [],
  workspaceProjectOrder: {},
  workspaceFold: {},
  alwaysShow: [],
  alwaysQuiet: [],
  quietAfterDays: 5,
  machines: {},
  projectAliases: {},
  projectMounts: {},
  projectMountStatus: {},
};
const BACKUP_DIR = join(
  process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
  "t3-mesh-migrate",
);

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Fail(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function localEnvironment() {
  return (await mcp()).call("t3_environment_read");
}

/** The replicated document when this server has the mesh, else the legacy settings config. */
async function layoutSnapshot() {
  try {
    const snapshot = await withWs((c) => c.rpc("meshLayout.get", {}));
    return { ...snapshot, legacy: false };
  } catch (error) {
    const settings = await withWs((c) => getSettings(c));
    return {
      environmentId: (await localEnvironment()).environmentId,
      document: null,
      config: settings.sidebarWorkspaces ?? EMPTY_LAYOUT,
      legacy: true,
      legacyReason: error instanceof Fail ? error.message : String(error),
    };
  }
}

async function peerLinksSummary() {
  try {
    return { links: (await withWs((c) => c.rpc("peerLinks.list", {}))).links ?? [], error: null };
  } catch (error) {
    return { links: [], error: error instanceof Fail ? error.message : String(error) };
  }
}

async function serverSettings() {
  return withWs((c) => getSettings(c));
}

/** Every machine the layout, the links and this server know about. */
async function collectMachines({ probe = false, layout, links } = {}) {
  const local = await localEnvironment();
  layout ??= await layoutSnapshot();
  links ??= (await peerLinksSummary()).links;
  const config = layout.config ?? EMPTY_LAYOUT;
  const byId = new Map();
  const ensure = (id) => {
    if (!byId.has(id)) byId.set(id, { environmentId: id });
    return byId.get(id);
  };
  ensure(local.environmentId);
  for (const id of Object.keys(config.machines ?? {})) ensure(id);
  for (const mounts of Object.values(config.projectMounts ?? {})) {
    for (const rep of mounts) {
      ensure(rep.environmentId);
      if (rep.source) ensure(rep.source);
    }
  }
  const linkById = new Map(links.map((link) => [link.environmentId, link]));
  for (const link of links) ensure(link.environmentId);
  const localReach = config.machines?.[local.environmentId]?.reach ?? {};
  const replicas = new Map();
  const primaries = new Map();
  for (const mounts of Object.values(config.projectMounts ?? {})) {
    for (const rep of mounts) {
      const target = rep.role === "replica" ? replicas : primaries;
      ensure(rep.environmentId);
      target.set(rep.environmentId, (target.get(rep.environmentId) ?? 0) + 1);
    }
  }
  const result = [];
  for (const [id, base] of byId) {
    const entry = config.machines?.[id] ?? {};
    const link = linkById.get(id);
    const isLocal = id === local.environmentId;
    const label = entry.label?.trim() || link?.label || (isLocal ? local.label : id);
    const machine = {
      ...base,
      environmentId: id,
      label,
      tag:
        String(entry.tag ?? "")
          .trim()
          .toUpperCase() || defaultMachineTag(label, id),
      color: entry.color ?? null,
      local: isLocal,
      linked: Boolean(link),
      linkLabel: link?.label ?? null,
      serverLabel: isLocal ? local.label : null,
      version: isLocal ? local.serverVersion : null,
      platform: isLocal ? local.platform : null,
      urls: link?.urls ?? [],
      access: link?.access ?? null,
      reachable: isLocal ? true : link ? link.status === "reachable" : null,
      lastReachedAt: link?.lastReachedAt ?? null,
      lastError: link?.lastError ?? null,
      sshAlias: localReach[id]?.ssh ?? null,
      replicas: replicas.get(id) ?? 0,
      primaries: primaries.get(id) ?? 0,
    };
    if (probe && link?.status === "reachable" && !isLocal) {
      try {
        const remote = await withTimeout(
          (await mcp()).call("t3_environment_read", { environmentId: id }),
          4000,
          `probe ${label}`,
        );
        machine.version = remote.serverVersion;
        machine.serverLabel = remote.label;
        machine.platform = remote.platform;
      } catch (error) {
        machine.probeError = error instanceof Fail ? error.message : String(error);
      }
    }
    result.push(machine);
  }
  return result.sort((a, b) => Number(b.local) - Number(a.local) || a.label.localeCompare(b.label));
}

async function getMachine(ref, options) {
  return resolveMachineRef(ref, await collectMachines(options));
}

/** Queryable machines: this server and every machine with a live link. */
async function queryableMachines() {
  const machines = await collectMachines();
  return machines.filter((m) => m.local || m.linked);
}

async function projectsInEnvironment(machine) {
  const m = await mcp();
  const out = [];
  let cursor = null;
  do {
    const page = await m.call("t3_project_list", {
      limit: 100,
      ...(machine.local ? {} : { environmentId: machine.environmentId }),
      ...(cursor !== null ? { cursor } : {}),
    });
    out.push(...page.projects.map((p) => ({ ...p, environmentId: machine.environmentId })));
    cursor = page.nextCursor;
  } while (cursor !== null && cursor !== undefined);
  return out;
}

async function threadsInEnvironment(machine, filter = {}) {
  const m = await mcp();
  const projects = await projectsInEnvironment(machine);
  const rows = [];
  for (const p of projects) {
    let cursor = null;
    do {
      const page = await m.call("t3_thread_list", {
        projectId: p.id,
        limit: 100,
        ...filter,
        ...(machine.local ? {} : { environmentId: machine.environmentId }),
        ...(cursor !== null ? { cursor } : {}),
      });
      rows.push(
        ...page.threads.map((t) => ({
          ...t,
          projectId: p.id,
          project: p.title,
          environmentId: machine.environmentId,
          machineLabel: machine.label,
          machineTag: machine.tag,
        })),
      );
      cursor = page.nextCursor;
    } while (cursor !== null && cursor !== undefined && rows.length < (filter.max ?? 1000));
  }
  return rows;
}

async function threadsAcrossMachines(machines, filter = {}, projectWords) {
  const rows = [];
  for (const machine of machines) {
    const envRows = await threadsInEnvironment(machine, filter);
    rows.push(...envRows);
  }
  const filtered = projectWords?.length
    ? rows.filter((t) =>
        projectWords.every((w) => `${t.project} ${t.projectId}`.toLowerCase().includes(w)),
      )
    : rows;
  return filtered.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

async function resolveThreadAcross(ref, { on } = {}) {
  if (!ref) die("thread is required (id, id prefix, or title words)");
  const machine = on ? await getMachine(on) : null;
  const r = String(ref);
  const m = await mcp();
  if (r.length > 30 || r.includes(":")) {
    try {
      const t = (
        await m.call("t3_thread_read", {
          threadId: r,
          limit: 1,
          ...(machine ? { environmentId: machine.environmentId } : {}),
        })
      ).thread;
      return {
        ...t,
        project: t.projectId,
        ...(machine
          ? {
              environmentId: machine.environmentId,
              machineLabel: machine.label,
              machineTag: machine.tag,
            }
          : {}),
      };
    } catch (error) {
      if (!(error instanceof Fail) || !error.message.includes("thread_not_found")) throw error;
    }
  }
  const candidates = [];
  let cursor;
  do {
    const page = await m.call("t3_thread_list", {
      environmentId: machine?.environmentId ?? "all",
      allProjects: true,
      includeSubagents: true,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const missing of page.unreachable ?? [])
      console.error(`${missing.environmentId}: ${missing.message}`);
    candidates.push(...page.threads.map((t) => ({ ...t, project: t.project ?? t.projectId })));
    cursor = page.nextCursor;
  } while (cursor !== null && cursor !== undefined);
  const exact = candidates.filter(
    (t) => t.threadId === r || t.threadId.startsWith(r) || short(t.threadId).startsWith(r),
  );
  if (exact.length === 1) return exact[0];
  const lower = r.toLowerCase();
  const titled = candidates.filter((t) => t.title.toLowerCase() === lower);
  if (titled.length === 1) return titled[0];
  const words = lower.split(/\s+/).filter(Boolean);
  const fuzzy = candidates.filter((t) =>
    words.every((w) => `${t.title} ${t.project}`.toLowerCase().includes(w)),
  );
  if (fuzzy.length === 1) return fuzzy[0];
  const top = fuzzy.filter((t) => !t.parentThreadId);
  if (top.length === 1) return top[0];
  if (!fuzzy.length) die(`no thread matches "${ref}" on ${machine?.label ?? "the mesh"}`);
  die(
    `"${ref}" is ambiguous:\n${fuzzy
      .slice(0, 15)
      .map((t) => `  ${t.threadId}  [${t.machineTag}] [${t.project}] ${t.title}`)
      .join("\n")}`,
  );
}

async function replicaLiveStatus() {
  try {
    const first = await withWs((c) => c.rpc("replicas.status", {}, { firstChunk: true }));
    const value = Array.isArray(first.value) ? first.value[0] : first.value;
    return { replicas: value?.replicas ?? [], disabled: false, error: null };
  } catch (error) {
    const message = error instanceof Fail ? error.message : String(error);
    return {
      replicas: [],
      disabled: /disabled|Unknown request tag/i.test(message),
      error: message,
    };
  }
}

function replicaRows(config, liveReplicas = []) {
  const rows = [];
  for (const [logicalKey, reps] of Object.entries(config.projectMounts ?? {})) {
    for (const rep of reps) {
      const live = liveReplicas.find(
        (x) => x.logicalKey === logicalKey && x.environmentId === rep.environmentId,
      );
      const stored = config.projectMountStatus?.[logicalKey]?.[rep.environmentId];
      rows.push({ logicalKey, rep, live: live ?? null, status: live ?? stored ?? null });
    }
  }
  return rows.sort(
    (a, b) =>
      a.logicalKey.localeCompare(b.logicalKey) ||
      a.rep.environmentId.localeCompare(b.rep.environmentId),
  );
}

function replicaStateText(row) {
  const state =
    row.live?.state ?? row.status?.state ?? (row.rep.projectId ? "watching" : "pending");
  const progress =
    row.live?.progress !== undefined ? ` ${Math.round(row.live.progress * 100)}%` : "";
  const conflicts = row.live?.conflicts?.length ?? row.status?.conflicts ?? 0;
  const message = row.live?.message ?? row.status?.message;
  return `${state}${progress}${conflicts ? `, ${conflicts} conflict(s)` : ""}${message ? ` — ${message}` : ""}`;
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
// `bin` stays unquoted so the remote shell expands `~`; arguments are quoted.
function remoteCommand(bin, args) {
  return [bin, ...args.map(shellQuote)].join(" ");
}

function sshRun(destination, args, { optional = false } = {}) {
  const candidates = [remoteCommand("t3ctl", args), remoteCommand("~/.local/bin/t3ctl", args)];
  let last;
  for (const command of candidates) {
    const r = spawnSync("ssh", ["-o", "BatchMode=yes", destination, command], { encoding: "utf8" });
    if (r.status === 0) return r.stdout;
    last = r.error ? r.error.message : (r.stderr || r.stdout).trim().split("\n").pop();
    if (!/not found|command not found|No such file/i.test(last ?? "")) break;
  }
  if (optional) return null;
  die(`ssh ${destination} failed: ${last || "unknown error"}`);
}

function parseJsonOutput(text) {
  const start = text.search(/[[{]/);
  if (start < 0) die(`expected JSON from the remote t3ctl, got: ${clip(text, 300)}`);
  try {
    return JSON.parse(text.slice(start));
  } catch (error) {
    die(`invalid JSON from the remote t3ctl: ${error.message}`);
  }
}

async function remoteLayout(destination) {
  const text = sshRun(destination, ["layout", "get", "--json"], { optional: true });
  if (text) {
    const parsed = parseJsonOutput(text);
    if (parsed?.document && parsed?.config)
      return { document: parsed.document, config: parsed.config };
  }
  const legacy = sshRun(destination, ["settings", "get", "sidebarWorkspaces"], { optional: true });
  if (!legacy) return null;
  return { document: null, config: parseJsonOutput(legacy) };
}

async function remotePairingCode(destination, baseDir) {
  const base = baseDir || process.env.T3CTL_REMOTE_HOME;
  const args = ["auth", "pairing", "create", "--ttl", "5m", "--label", "t3ctl-link", "--json"];
  if (base) args.push("--base-dir", base);
  const remoteBin = process.env.T3CTL_REMOTE_T3_BIN;
  const candidates = remoteBin ? [shellQuote(remoteBin)] : ["~/.local/bin/t3", "t3"];
  let r;
  for (const bin of candidates) {
    r = spawnSync("ssh", ["-o", "BatchMode=yes", destination, remoteCommand(bin, args)], {
      encoding: "utf8",
    });
    if (r.status === 0) break;
  }
  if (r.status !== 0)
    die(
      `could not mint a pairing code on ${destination}: ${(r.stderr || r.stdout).trim().split("\n").pop()}`,
    );
  const parsed = parseJsonOutput(r.stdout);
  const credential = parsed.credential ?? parsed.code;
  if (!credential)
    die(`pairing code output from ${destination} has no credential: ${clip(r.stdout, 300)}`);
  return credential;
}

async function tryUiOpen(target) {
  try {
    return { clients: (await (await mcp()).call("ui_open", { target })).clients, note: null };
  } catch (error) {
    const message = error instanceof Fail ? error.message : String(error);
    if (
      /thread_credential_required|needs an agent running inside T3 Code|signed in from outside a thread/.test(
        message,
      )
    ) {
      return {
        clients: null,
        note: "ui_open runs as the calling T3 thread, so an outside client only gets the link. Ask an agent in that thread, or open the link.",
      };
    }
    throw error;
  }
}

async function listProjects() {
  const m = await mcp();
  const out = [];
  let cursor = null;
  do {
    const page = await m.call("t3_project_list", {
      limit: 100,
      ...(cursor !== null ? { cursor } : {}),
    });
    out.push(...page.projects);
    cursor = page.nextCursor;
  } while (cursor !== null && cursor !== undefined);
  return out;
}

async function resolveProject(ref, projects) {
  if (!ref) die("project is required (name, id prefix or folder path)");
  projects ??= await listProjects();
  const r = String(ref);
  const path = r.startsWith("/") || r.startsWith("~") || r.startsWith(".") ? expandHome(r) : null;
  if (path) {
    const p = projects.find((x) => x.workspaceRoot === path);
    if (p) return p;
    die(`no project at ${path}`);
  }
  const byId = projects.filter(
    (p) => p.id === r || p.id.startsWith(r) || short(p.id).startsWith(r),
  );
  if (byId.length === 1) return byId[0];
  const lower = r.toLowerCase();
  const exact = projects.filter(
    (p) => p.title.toLowerCase() === lower || basename(p.workspaceRoot).toLowerCase() === lower,
  );
  if (exact.length === 1) return exact[0];
  const fuzzy = projects.filter((p) =>
    lower.split(/\s+/).every((w) => `${p.title} ${p.workspaceRoot}`.toLowerCase().includes(w)),
  );
  if (fuzzy.length === 1) return fuzzy[0];
  if (!fuzzy.length) die(`no project matches "${ref}" (see: t3ctl projects)`);
  die(
    `"${ref}" is ambiguous:\n${fuzzy.map((p) => `  ${short(p.id)}  ${p.title}  ${p.workspaceRoot}`).join("\n")}`,
  );
}

async function listThreads(projects, filter = {}) {
  const m = await mcp();
  const pages = await Promise.all(
    projects.map(async (p) => {
      const rows = [];
      let cursor = null;
      do {
        const page = await m.call("t3_thread_list", {
          projectId: p.id,
          limit: 100,
          ...filter,
          ...(cursor !== null ? { cursor } : {}),
        });
        rows.push(...page.threads.map((t) => ({ ...t, projectId: p.id, project: p.title })));
        cursor = page.nextCursor;
      } while (cursor !== null && cursor !== undefined && rows.length < (filter.max ?? 1000));
      return rows;
    }),
  );
  return pages.flat().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

async function archivedThreads() {
  return withWs(async (c) => {
    const snap = await c.rpc("orchestration.getArchivedShellSnapshot", {});
    const titles = new Map((snap.projects || []).map((p) => [p.id, p.title]));
    return (snap.threads || []).map((t) => ({
      ...t,
      threadId: t.id ?? t.threadId,
      model: t.model ?? t.modelSelection?.model,
      status: t.status ?? t.latestRun?.status ?? "archived",
      project: titles.get(t.projectId) ?? "?",
      archived: true,
    }));
  });
}

async function resolveThread(ref, { projectRef, includeArchived } = {}) {
  if (!ref) die("thread is required (id, id prefix, or title words)");
  const r = String(ref);
  const m = await mcp();
  // Full ids resolve directly (cheap), including archived threads.
  if (r.length > 30 || r.includes(":")) {
    try {
      const t = (await m.call("t3_thread_read", { threadId: r, limit: 1 })).thread;
      if (t) return { ...t, project: t.projectId };
    } catch {
      /* fall through */
    }
  }
  const projects = await listProjects();
  const scope = projectRef ? [await resolveProject(projectRef, projects)] : projects;
  let rows = await listThreads(scope, { includeSubagents: true });
  if (includeArchived) rows = rows.concat(await archivedThreads());
  const exact = rows.filter(
    (t) => t.threadId === r || t.threadId.startsWith(r) || short(t.threadId).startsWith(r),
  );
  if (exact.length === 1) return exact[0];
  const lower = r.toLowerCase();
  const titled = rows.filter((t) => t.title.toLowerCase() === lower);
  if (titled.length === 1) return titled[0];
  const words = lower.split(/\s+/).filter(Boolean);
  const fuzzy = rows.filter((t) =>
    words.every((w) => `${t.title} ${t.project}`.toLowerCase().includes(w)),
  );
  if (fuzzy.length === 1) return fuzzy[0];
  const top = fuzzy.filter((t) => !t.parentThreadId);
  if (top.length === 1) return top[0];
  if (!fuzzy.length)
    die(
      `no thread matches "${ref}"${includeArchived ? "" : " (archived threads: add --archived)"}`,
    );
  die(
    `"${ref}" is ambiguous:\n${fuzzy
      .slice(0, 15)
      .map((t) => `  ${t.threadId}  [${t.project}] ${t.title}`)
      .join("\n")}`,
  );
}

const threadLine = (t) =>
  `${t.threadId.padEnd(8)}  ${String(t.pendingRequestCount ? "waiting" : t.status).padEnd(11)} ${ago(t.updatedAt).padStart(8)}  ${clip(`${t.providerInstanceId === "claudeAgent" ? "claude" : t.providerInstanceId}:${t.model}`, 26).padEnd(26)} ${t.machineTag ? `[${t.machineTag}] ` : ""}[${clip(t.project, 18)}] ${t.title}${t.parentThreadId ? `  (${t.relationshipToParent ?? "child"})` : ""}${t.settled ? "  (settled)" : ""}${t.snoozed ? "  (snoozed)" : ""}${t.archived ? "  (archived)" : ""}`;

async function modelSelection(opt, { required = true } = {}) {
  if (!opt.agent && !opt.model && !opt.effort && !opt.fast && !opt.opt)
    return required ? defaultSelection() : null;
  let agent = String(opt.agent || "").trim();
  let model = opt.model ? String(opt.model) : "";
  model = MODEL_ALIASES[model.toLowerCase()] ?? model;
  const aliasModel = MODEL_ALIASES[agent.toLowerCase()];
  if (aliasModel && !model) model = aliasModel;
  if (agent) agent = AGENT_ALIASES[agent.toLowerCase()] ?? agent;
  const caps = await (await mcp()).call("orchestrator_capabilities");
  const providers = caps.providers || [];
  if (!agent && model)
    agent = providers.find((p) => p.models.some((x) => x.id === model))?.providerInstanceId ?? "";
  if (!agent) agent = AGENT_ALIASES[DEFAULTS.agent] ?? DEFAULTS.agent;
  const prov =
    providers.find((p) => p.providerInstanceId === agent) ??
    providers.find((p) => p.driverKind === agent);
  if (!prov)
    die(
      `unknown agent/harness "${agent}". Available: ${providers.map((p) => p.providerInstanceId).join(", ")} (t3ctl models)`,
    );
  if (!model)
    model =
      prov.driverKind === "claudeAgent"
        ? DEFAULTS.claudeModel
        : prov.driverKind === "codex"
          ? DEFAULTS.codexModel
          : prov.models[0]?.id;
  const m = prov.models.find((x) => x.id === model);
  if (!m)
    die(
      `model "${model}" is not offered by ${prov.providerInstanceId}. Models: ${prov.models.map((x) => x.id).join(", ")}`,
    );
  const options = [];
  const setOpt = (id, value) => {
    const def = (m.options || []).find((o) => o.id === id);
    if (!def)
      die(
        `${m.id} has no option "${id}". Options: ${(m.options || []).map((o) => `${o.id}${o.options ? `=${o.options.map((v) => v.id).join("|")}` : ""}`).join(", ") || "none"}`,
      );
    if (def.type === "boolean") value = value === true || value === "true";
    else if (def.options && !def.options.some((v) => v.id === value))
      die(`${id} must be one of ${def.options.map((v) => v.id).join(", ")}`);
    options.push({ id, value });
  };
  if (opt.effort)
    setOpt((m.options || []).find((o) => /effort/i.test(o.id))?.id ?? "effort", String(opt.effort));
  if (opt.fast)
    setOpt(
      (m.options || []).find((o) => o.id === "serviceTier") ? "serviceTier" : "fastMode",
      (m.options || []).find((o) => o.id === "serviceTier") ? "priority" : true,
    );
  for (const kv of opt.opt || []) {
    const i = String(kv).indexOf("=");
    if (i < 1) die(`--opt expects key=value, got "${kv}"`);
    setOpt(kv.slice(0, i), kv.slice(i + 1));
  }
  return {
    instanceId: prov.providerInstanceId,
    model: m.id,
    ...(options.length ? { options } : {}),
  };
}

function defaultSelection() {
  const agent = AGENT_ALIASES[DEFAULTS.agent] ?? DEFAULTS.agent;
  return {
    instanceId: agent,
    model: agent === "claudeAgent" ? DEFAULTS.claudeModel : DEFAULTS.codexModel,
  };
}

function runtimeMode(opt) {
  const m = opt.mode || DEFAULTS.mode;
  if (!RUNTIME_MODES.includes(m)) die(`--mode must be one of ${RUNTIME_MODES.join(", ")}`);
  return m;
}

// Pages through the whole timeline. Long item texts come back truncated; `expand` fetches the
// rest for every item ('all'), only the given items (a predicate), or none (false).
async function readAll(
  threadId,
  { view = "messages", maxCharsPerItem = 50000, expand = "all", environmentId } = {},
) {
  const m = await mcp();
  let after = null;
  let head;
  const items = [];
  for (let i = 0; i < 200; i++) {
    const page = await m.call("t3_thread_read", {
      threadId,
      view,
      limit: 100,
      maxCharsPerItem,
      ...(environmentId ? { environmentId } : {}),
      ...(after !== null ? { afterPosition: after } : {}),
    });
    head ??= page;
    items.push(...page.items);
    if (!page.hasMore) break;
    after = page.nextPosition;
  }
  for (const it of items) {
    if (expand !== "all" && !(typeof expand === "function" && expand(it, items))) continue;
    let off = it.nextTextOffset;
    while (it.textTruncated && off !== null && off !== undefined) {
      const more = await m.call("t3_thread_read", {
        threadId,
        itemId: it.itemId,
        textOffset: off,
        maxCharsPerItem,
        ...(environmentId ? { environmentId } : {}),
      });
      const x = more.item ?? more.items?.[0];
      if (!x) break;
      it.text += x.text ?? "";
      off = x.nextTextOffset;
      if (off === null || off === undefined) it.textTruncated = false;
    }
  }
  return { ...head, items };
}

const isAnswer = (i) => i.type === "assistant_message" || i.type === "proposed_plan";
const isLastAnswer = (it, items) => it === [...items].reverse().find(isAnswer);

const ITEM_LABEL = { user_message: "you", assistant_message: "agent", proposed_plan: "plan" };

// sidebar.54+ (upstream v0.1.5) dropped server.getSettings; the config carries the settings.
async function getSettings(c) {
  const config = await c.rpc("server.getConfig", {});
  if (config?.settings) return config.settings;
  return c.rpc("server.getSettings", {});
}
async function patchWorkspaces(c, fn) {
  const s = await getSettings(c);
  const cur = s.sidebarWorkspaces ?? {
    workspaces: [],
    assignments: {},
    rules: [],
    defaultWorkspace: null,
    projectOrder: [],
    alwaysShow: [],
    quietAfterDays: 5,
  };
  const next = fn(structuredClone(cur));
  const saved = await c.rpc("server.updateSettings", { patch: { sidebarWorkspaces: next } });
  return saved.sidebarWorkspaces;
}
const WS_COLORS = [
  "#e0795b",
  "#6d8cff",
  "#4fb58f",
  "#c77dff",
  "#f2b84b",
  "#4cc3d9",
  "#ff6b9a",
  "#9aa5b1",
];
function wsId(name, taken) {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9а-яё]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "workspace";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
function resolveWs(cfg, ref) {
  const r = String(ref ?? "").toLowerCase();
  const w =
    cfg.workspaces.find((x) => x.id.toLowerCase() === r) ??
    cfg.workspaces.find((x) => x.name.toLowerCase() === r) ??
    (cfg.workspaces.filter((x) => x.name.toLowerCase().includes(r)).length === 1
      ? cfg.workspaces.find((x) => x.name.toLowerCase().includes(r))
      : undefined);
  if (!w)
    die(
      `no workspace "${ref}". Workspaces: ${cfg.workspaces.map((x) => `${x.name} (${x.id})`).join(", ") || "none"}`,
    );
  return w;
}
function globRe(glob) {
  let s = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        s += ".*";
        i++;
      } else s += "[^/]*";
    } else if (ch === "?") s += "[^/]";
    else s += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${s}$`);
}
const isScratch = (p) =>
  p.projectIcon?.name === "message-square-dashed" && /\/scratch$/.test(p.workspaceRoot);
// "No project" is stored under one key for every environment and client.
// The project list can come back without `repositoryIdentity` while the server is still resolving
// it (e.g. right after a restart). Writes pass `settle` so they re-read the project a few times
// instead of saving under the env:path key, which no client would match.
async function projectKey(p, settle = false) {
  if (isScratch(p)) return "no-project";
  if (p.repositoryIdentity?.canonicalKey) return p.repositoryIdentity.canonicalKey;
  for (let i = 0; settle && i < 5; i++) {
    const full = await (await mcp()).call("t3_project_read", { projectId: p.id });
    if (full.repositoryIdentity?.canonicalKey) return full.repositoryIdentity.canonicalKey;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const env = await (await mcp()).call("t3_environment_read");
  return `${env.environmentId}:${p.workspaceRoot}`;
}
function workspaceOf(cfg, key, root) {
  const known = new Set(cfg.workspaces.map((w) => w.id));
  if (known.has(cfg.assignments[key])) return cfg.assignments[key];
  for (const rule of cfg.rules)
    if (known.has(rule.workspace) && globRe(rule.match).test(root)) return rule.workspace;
  return (known.has(cfg.defaultWorkspace) ? cfg.defaultWorkspace : cfg.workspaces[0]?.id) ?? null;
}
// Every workspace a project shows in (`placements`, servers newer than sidebar.17), in tile order.
// "No project" (the server's scratch project) shows in every workspace until placed.
function workspacesOf(cfg, key, root, scratch = false) {
  const placed = new Set(cfg.placements?.[key] ?? []);
  const shown = cfg.workspaces.map((w) => w.id).filter((id) => placed.has(id));
  if (shown.length) return shown;
  if (scratch) return cfg.workspaces.map((w) => w.id);
  const one = workspaceOf(cfg, key, root);
  return one ? [one] : [];
}
// Shows a project in exactly `ids` (never none); a workspace that newly shows it gets it on top.
function placeProject(cfg, key, root, ids, scratch = false) {
  const wanted = new Set(ids);
  const next = cfg.workspaces.map((w) => w.id).filter((id) => wanted.has(id));
  if (!next.length) die("a project must show in at least one workspace");
  const before = new Set(workspacesOf(cfg, key, root, scratch));
  cfg.workspaceProjectOrder ??= {};
  for (const id of next) {
    if (before.has(id) || scratch) continue; // "No project" sits last, outside the orders
    const order = (cfg.workspaceProjectOrder[id] ?? cfg.projectOrder ?? []).filter(
      (k) => k !== key,
    );
    cfg.workspaceProjectOrder[id] = [key, ...order];
  }
  cfg.placements = { ...cfg.placements, [key]: next };
  cfg.assignments[key] = next[0];
}

const THREAD_ORGANIZE = ["pin", "unpin", "settle", "unsettle", "archive", "unarchive", "unsnooze"];

const commands = {
  agents: async (pos, opt) => (await import("./agents-sync.mjs")).runAgents(pos, opt),
  // Agent inbox (fork). Agents' side through MCP (t3ctl posts as an MCP client, not a thread);
  // the owner's side (reply, dismiss, reopen) through the UI's WS RPC.
  async inbox(pos, opt) {
    const sub = pos[0] && !pos[0].startsWith("issue-") ? pos[0] : "list";
    const args = sub === pos[0] ? pos.slice(1) : pos;
    const mark = { action: "🔴", attention: "🟡", info: "⚪" };
    const call = async (name, input) => (await mcp()).call(name, input);
    const resolveIssue = async (ref) => {
      if (!ref) die(`usage: t3ctl inbox ${sub} <issue-id or prefix> …`);
      const { issues } = await call("inbox_list", { state: "all", limit: 200 });
      const hits = issues.filter(
        (i) => i.id === ref || i.id.startsWith(ref) || i.id.startsWith(`issue-${ref}`),
      );
      if (hits.length === 1) return hits[0].id;
      if (ref.startsWith("issue-")) return ref;
      die(
        hits.length
          ? `"${ref}" matches ${hits.length} issues; use more of the id`
          : `no inbox issue "${ref}"`,
      );
    };
    const line = (i) => {
      const unread = i.notableSequence > i.seenSequence ? "●" : " ";
      const waiting = i.state === "open" && i.waitingForOwner ? " ⏳ needs owner" : "";
      const closed =
        i.state === "open" ? "" : ` [${i.state}${i.closedBy ? ` by ${i.closedBy}` : ""}]`;
      const repeats = i.repeatCount ? ` ×${i.repeatCount + 1}` : "";
      return `${mark[i.severity]} ${unread} ${i.title}${repeats}${waiting}${closed}  — ${i.source.label}, ${ago(i.activityAt)}  [${i.id.replace(/^issue-/, "").slice(0, 8)}]`;
    };
    const show = (detail) => {
      if (opt.json) return json(detail);
      const i = detail.issue;
      console.log(line(i));
      console.log(
        `id ${i.id}${i.dedupeKey ? `  key ${i.dedupeKey}` : ""}  responsible ${i.responsibleThreadId ?? "-"}  project ${i.projectId ?? "-"}`,
      );
      if (i.description) console.log(`\n${i.description}\n`);
      for (const e of detail.entries) {
        const who =
          e.author === "owner"
            ? "owner"
            : e.author === "agent"
              ? `agent${e.threadId ? ` ${e.threadId}` : ""}`
              : "system";
        const failed = e.deliveries
          .filter((d) => d.status === "failed")
          .map((d) => ` ⚠ not delivered: ${d.error}`)
          .join("");
        console.log(
          `  ${ago(e.createdAt).padEnd(8)} ${e.kind.padEnd(15)} ${who.padEnd(15)} ${e.text ? clip(e.text, 300) : ""}${failed}`,
        );
      }
    };
    const owner = async (method, payload) => withWs((c) => c.rpc(method, payload));
    const text = () => readMessage(args.slice(1), opt).trim();
    const waiting =
      opt.waiting === true
        ? { waitingForOwner: true }
        : opt.notWaiting === true
          ? { waitingForOwner: false }
          : {};

    if (sub === "list") {
      const state = opt.all
        ? "all"
        : opt.closed
          ? "resolved"
          : opt.dismissed
            ? "dismissed"
            : "open";
      const { issues } = await call("inbox_list", {
        state,
        ...(opt.limit ? { limit: Number(opt.limit) } : {}),
      });
      if (opt.json) return json(issues);
      if (!issues.length)
        return console.log(
          state === "open" ? "All quiet: no open inbox issues." : "No inbox issues.",
        );
      for (const i of issues) console.log(line(i));
      return;
    }
    if (sub === "show")
      return show(await call("inbox_get", { issueId: await resolveIssue(args[0]) }));
    if (sub === "post") {
      const severity = args[0];
      const title = opt.title ?? args.slice(1).join(" ");
      const description = opt.body ?? (opt.file ? readMessage([], opt) : "");
      if (!["action", "attention", "info"].includes(severity) || !title)
        die(
          'usage: t3ctl inbox post <action|attention|info> "Title" --body "Markdown" [--key DEDUPE_KEY] [--project P] [--waiting]',
        );
      const projectId = opt.project ? (await resolveProject(opt.project)).id : undefined;
      const r = await call("inbox_post", {
        severity,
        title,
        description,
        ...(opt.key ? { dedupeKey: String(opt.key) } : {}),
        ...(projectId ? { projectId } : {}),
        ...waiting,
      });
      return opt.json
        ? json(r)
        : console.log(`${r.outcome}: ${r.issueId} (${r.state})\n${r.message}`);
    }
    if (sub === "comment") {
      const issueId = await resolveIssue(args[0]);
      const body = text();
      if (!body)
        die('usage: t3ctl inbox comment <id> "text" [--waiting | --not-waiting]   (as an agent)');
      return show(await call("inbox_comment", { issueId, text: body, ...waiting }));
    }
    if (sub === "update") {
      const issueId = await resolveIssue(args[0]);
      return show(
        await call("inbox_update", {
          issueId,
          ...waiting,
          ...(opt.severity ? { severity: opt.severity } : {}),
          ...(opt.title ? { title: opt.title } : {}),
          ...(opt.body ? { description: opt.body } : {}),
          ...(opt.thread
            ? { responsibleThreadId: (await resolveThread(opt.thread)).threadId }
            : {}),
        }),
      );
    }
    if (sub === "done" || sub === "resolve") {
      const issueId = await resolveIssue(args[0]);
      const resolution = text();
      if (!resolution) die('usage: t3ctl inbox done <id> "how it was fixed and verified"');
      return show(await call("inbox_resolve", { issueId, resolution }));
    }
    if (sub === "reply") {
      const issueId = await resolveIssue(args[0]);
      const body = text();
      if (!body)
        die(
          'usage: t3ctl inbox reply <id> "text"   (as the owner; goes to the responsible thread)',
        );
      return show(await owner("inbox.comment", { issueId, text: body }));
    }
    if (sub === "dismiss") {
      const issueId = await resolveIssue(args[0]);
      const reason = text();
      if (!reason) die('usage: t3ctl inbox dismiss <id> "reason"   (owner: close as not relevant)');
      return show(
        await call("inbox_get", {
          issueId: (await owner("inbox.dismiss", { issueId, reason })).issue.id,
        }),
      );
    }
    if (sub === "reopen") {
      const issueId = await resolveIssue(args[0]);
      return show(
        await call("inbox_get", {
          issueId: (await owner("inbox.undismiss", { issueId })).issue.id,
        }),
      );
    }
    die(
      "usage: t3ctl inbox [list|show|post|comment|update|done|reply|dismiss|reopen] …   (t3ctl help)",
    );
  },
  async login(pos, opt) {
    const { origin } = serverInfo();
    const t = await login(origin);
    if (opt.json) json({ ...t, accessToken: undefined });
  },

  async doctor() {
    const lines = [];
    const ok = (k, v) => lines.push(`ok    ${k.padEnd(16)} ${v}`);
    const bad = (k, v) => lines.push(`FAIL  ${k.padEnd(16)} ${v}`);
    let info;
    try {
      info = serverInfo();
      ok("server", `${info.origin} (pid ${info.pid ?? "?"})`);
    } catch (e) {
      bad("server", e.message);
      console.log(lines.join("\n"));
      process.exitCode = 1;
      return;
    }
    try {
      const m = await mcp();
      const v = m.server?.serverInfo?.version;
      (TESTED_VERSIONS.includes(v) ? ok : (k, x) => lines.push(`warn  ${k.padEnd(16)} ${x}`))(
        "version",
        `${v} (t3ctl tested on ${TESTED_VERSIONS.join(", ")}${TESTED_VERSIONS.includes(v) ? "" : "; run scripts/selftest.sh on a test server"})`,
      );
      ok("mcp token", `expires ${m.token.expiresAt} (${tokenFile(info.origin)})`);
      const tools = await m.tools();
      const need = [
        "t3_project_list",
        "t3_thread_list",
        "t3_thread_read",
        "t3_thread_launch",
        "t3_thread_send",
        "t3_thread_interrupt",
        "t3_thread_transfer",
        "t3_thread_organize",
        "t3_thread_configure",
        "t3_thread_update",
        "t3_thread_wait",
        "orchestrator_capabilities",
        "t3_project_create",
        "t3_project_delete",
      ];
      const miss = need.filter((n) => !tools.some((t) => t.name === n));
      (miss.length ? bad : ok)(
        "mcp tools",
        miss.length ? `missing: ${miss.join(", ")}` : `${tools.length} tools`,
      );
      const caps = await m.call("orchestrator_capabilities");
      ok(
        "harnesses",
        caps.providers.map((p) => `${p.providerInstanceId}(${p.models.length})`).join(" "),
      );
      const projects = await listProjects();
      ok("projects", String(projects.length));
    } catch (e) {
      bad("mcp", e.message);
    }
    try {
      await withWs(async (c) => {
        const s = await getSettings(c);
        ok(
          "ws rpc",
          `settings ok, ${s.sidebarWorkspaces?.workspaces?.length ?? 0} sidebar workspaces`,
        );
      });
    } catch (e) {
      bad("ws rpc", e.message);
    }
    try {
      const st = execFileSync("systemctl", ["--user", "is-active", UNIT], {
        encoding: "utf8",
      }).trim();
      ok("unit", `${UNIT} ${st}`);
    } catch {
      lines.push(
        `warn  ${"unit".padEnd(16)} ${UNIT} not active or unknown (fine if the server runs another way)`,
      );
    }
    try {
      const env = await (await mcp()).call("t3_environment_read");
      let layout = "legacy settings (no meshLayout RPC)";
      try {
        const snap = await withWs((c) => c.rpc("meshLayout.get", {}));
        layout = `meshLayout ${Object.keys(snap.document).length} entries, ${snap.config.workspaces?.length ?? 0} workspace(s)`;
      } catch {
        /* older build: the legacy settings section above still works */
      }
      const { links, error } = await peerLinksSummary();
      const reachable = links.filter((l) => l.status === "reachable").length;
      ok(
        "mesh",
        `${env.label} ${short(env.environmentId)} · ${layout} · ${links.length} link(s), ${reachable} reachable${error ? ` (${clip(error, 80)})` : ""}`,
      );
      const tools = await (await mcp()).tools();
      const place = ["t3_project_place", "t3_project_machines"].filter((n) =>
        tools.some((t) => t.name === n),
      );
      lines.push(
        `${place.length === 2 ? "ok    " : "warn  "}${"mesh tools".padEnd(16)} ${place.length === 2 ? place.join(", ") : "no t3_project_place/t3_project_machines (needs the replica build)"}`,
      );
      const settings = await serverSettings();
      if (settings)
        lines.push(
          `warn  ${"mesh flags".padEnd(16)} linkedEnvironments=${settings.linkedEnvironmentsEnabled} mesh=${settings.meshEnabled} replicas=${settings.replicasEnabled}`,
        );
    } catch (e) {
      lines.push(`warn  ${"mesh".padEnd(16)} ${clip(e.message, 200)}`);
    }
    console.log(lines.join("\n"));
    if (lines.some((l) => l.startsWith("FAIL"))) process.exitCode = 1;
  },

  async env(pos, opt) {
    const e = await (await mcp()).call("t3_environment_read");
    if (opt.json) return json(e);
    console.log(
      `${e.label}  ${e.serverVersion}  ${e.platform?.os}/${e.platform?.arch}  environment ${e.environmentId}`,
    );
  },

  async models(pos, opt) {
    const caps = await (await mcp()).call("orchestrator_capabilities");
    if (opt.json) return json(caps);
    const want = pos[0] || opt.agent;
    for (const p of caps.providers) {
      if (
        want &&
        ![p.providerInstanceId, p.driverKind, AGENT_ALIASES[String(want).toLowerCase()]].includes(
          want,
        ) &&
        p.providerInstanceId !== AGENT_ALIASES[String(want).toLowerCase()]
      )
        continue;
      console.log(`${p.providerInstanceId}  (${p.displayName}, driver ${p.driverKind})`);
      for (const m of p.models) {
        const opts = (m.options || [])
          .map(
            (o) =>
              `${o.id}=${o.options ? o.options.map((v) => v.id + (v.isDefault ? "*" : "")).join("|") : o.type}`,
          )
          .join("  ");
        console.log(`  ${m.id.padEnd(28)} ${opts}`);
      }
    }
  },

  async projects(pos, opt) {
    const projects = await listProjects();
    if (opt.json) return json(projects);
    const counts = await listThreads(projects).then((rows) =>
      rows.reduce((acc, t) => ((acc[t.projectId] = (acc[t.projectId] || 0) + 1), acc), {}),
    );
    for (const p of projects)
      console.log(
        `${short(p.id).padEnd(8)}  ${clip(p.title, 30).padEnd(30)} ${String(counts[p.id] || 0).padStart(3)} threads  ${p.workspaceRoot}`,
      );
  },

  async project(pos, opt) {
    const p = await resolveProject(pos[0]);
    const full = await (await mcp()).call("t3_project_read", { projectId: p.id });
    if (opt.json) return json(full);
    console.log(JSON.stringify(full, null, 2));
  },

  async "project-add"(pos, opt) {
    if (!pos[0]) die("usage: t3ctl project-add <path> [--title T] [--mkdir]");
    const path = expandHome(pos[0]);
    if (!existsSync(path) && !opt.mkdir) die(`${path} does not exist (pass --mkdir to create it)`);
    if (existsSync(path) && !statSync(path).isDirectory()) die(`${path} is not a directory`);
    const existing = (await listProjects()).find((p) => p.workspaceRoot === path);
    if (existing) {
      console.log(`already a project: ${existing.title} (${existing.id})`);
      return;
    }
    const p = await (
      await mcp()
    ).call("t3_project_create", {
      title: opt.title || basename(path),
      workspaceRoot: path,
      ...(opt.mkdir ? { createWorkspaceRootIfMissing: true } : {}),
    });
    if (opt.json) return json(p);
    console.log(`added project ${p.title} (${p.id}) → ${p.workspaceRoot}`);
  },

  async "project-new"(pos, opt) {
    const title = pos.join(" ");
    if (!title)
      die(
        'usage: t3ctl project-new "title"   (T3 creates a fresh git repo for it in its projects folder)',
      );
    const p = await (await mcp()).call("t3_project_create", { title });
    if (opt.json) return json(p);
    console.log(
      `created project ${p.title} (${p.id}) → ${p.workspaceRoot}${p.commitError ? `  (commit: ${p.commitError})` : ""}`,
    );
  },

  async "project-clone"(pos, opt) {
    if (!pos[0])
      die(
        "usage: t3ctl project-clone <url|owner/name> [--dest PATH | --dir PARENT (default ~/Repos)] [--title T]",
      );
    const src = String(pos[0]);
    const isUrl = /:\/\/|^git@/.test(src);
    const name = basename(src.replace(/\.git$/, "").replace(/\/+$/, ""));
    const dest = opt.dest ? expandHome(opt.dest) : join(expandHome(opt.dir || "~/Repos"), name);
    const m = await mcp();
    const r = await m.call("t3_project_clone", {
      ...(isUrl ? { remoteUrl: src } : { repository: src }),
      destinationPath: dest,
    });
    const cwd = r.cwd ?? r.path ?? r.workspaceRoot ?? dest;
    const p = await m.call("t3_project_create", { title: opt.title || name, workspaceRoot: cwd });
    console.log(`cloned ${src} → ${cwd}; project ${p.title} (${p.id})`);
  },

  async "project-rename"(pos) {
    const p = await resolveProject(pos[0]);
    const title = pos.slice(1).join(" ");
    if (!title) die('usage: t3ctl project-rename <project> "new title"');
    await (await mcp()).call("t3_project_update", { projectId: p.id, title });
    console.log(`renamed ${p.title} → ${title}`);
  },

  async "project-set"(pos, opt) {
    const p = await resolveProject(pos[0]);
    const patch = { projectId: p.id };
    if (opt.agent || opt.model || opt.effort || opt.opt || opt.fast)
      patch.defaultModelSelection = await modelSelection(opt);
    if (opt.root) patch.workspaceRoot = expandHome(opt.root);
    if (opt.autoPull !== undefined)
      patch.autoPull = opt.autoPull === true || opt.autoPull === "true";
    if (opt.envMode) patch.defaultThreadEnvMode = opt.envMode;
    if (opt.emoji) patch.projectIcon = { kind: "emoji", emoji: opt.emoji };
    if (opt.json) Object.assign(patch, readJsonArg(opt.json));
    if (Object.keys(patch).length === 1)
      die(
        "nothing to set: --agent/--model/--effort, --root, --auto-pull, --env-mode local|worktree, --emoji, --json '{...}'",
      );
    await (await mcp()).call("t3_project_update", patch);
    console.log(`updated ${p.title}`);
  },

  async "project-remove"(pos, opt) {
    const p = await resolveProject(pos[0]);
    if (!opt.yes)
      die(
        `this removes project "${p.title}" from T3 (files on disk stay)${opt.force ? " AND deletes its threads" : ""}. Re-run with --yes`,
      );
    await (await mcp()).call("t3_project_delete", { projectId: p.id, force: Boolean(opt.force) });
    console.log(`removed project ${p.title}`);
  },

  async machines(pos, opt) {
    // Reachable links are probed for their label and version; `--probe` is kept for older habits.
    const machines = await collectMachines({ probe: true });
    if (opt.json) return json(machines);
    for (const m of machines) {
      const state = m.local
        ? "local"
        : m.linked
          ? m.reachable === false
            ? "linked, unreachable"
            : m.reachable === true
              ? "linked, reachable"
              : "linked"
          : "not linked";
      const reps = [
        m.primaries ? `${m.primaries} primary` : "",
        m.replicas ? `${m.replicas} replica` : "",
      ]
        .filter(Boolean)
        .join(", ");
      console.log(
        `${m.tag.padEnd(3)} ${clip(m.label, 20).padEnd(20)} ${short(m.environmentId).padEnd(8)} ${String(m.version ?? "-").padEnd(18)} ${state}${reps ? `, ${reps}` : ""}${m.sshAlias ? `  ssh ${m.sshAlias}` : ""}`,
      );
      if (m.probeError) console.log(`    probe: ${clip(m.probeError, 160)}`);
    }
  },

  async mesh(pos, opt) {
    const sub = pos[0] || "status";
    if (sub === "status") {
      const layout = await layoutSnapshot();
      const { links, error: linksError } = await peerLinksSummary();
      const machines = await collectMachines({ layout, links });
      const live = await replicaLiveStatus();
      const settings = await serverSettings();
      const rows = replicaRows(layout.config, live.replicas);
      const result = {
        local: machines.find((m) => m.local) ?? null,
        layout: {
          legacy: layout.legacy,
          environmentId: layout.environmentId,
          entries: layout.document ? Object.keys(layout.document).length : null,
          revision: layout.document
            ? Object.values(layout.document).reduce((max, e) => (e.h > max ? e.h : max), "")
            : null,
          workspaces: layout.config.workspaces?.length ?? 0,
          representations: rows.length,
          logicalProjects: Object.keys(layout.config.projectMounts ?? {}).length,
        },
        links,
        linksError,
        machines,
        replicas: rows.map((row) => ({
          logicalKey: row.logicalKey,
          environmentId: row.rep.environmentId,
          role: row.rep.role,
          transport: row.rep.transport,
          path: row.rep.path,
          projectId: row.rep.projectId ?? null,
          state: row.live?.state ?? row.status?.state ?? null,
          progress: row.live?.progress ?? null,
          conflicts: row.live?.conflicts?.length ?? row.status?.conflicts ?? 0,
          message: row.live?.message ?? row.status?.message ?? null,
        })),
        replicasError: live.error,
        settings: settings
          ? {
              linkedEnvironmentsEnabled: settings.linkedEnvironmentsEnabled,
              meshEnabled: settings.meshEnabled,
              replicasEnabled: settings.replicasEnabled,
            }
          : null,
      };
      if (opt.json) return json(result);
      const local = result.local;
      const tagOf = (environmentId) =>
        machines.find((m) => m.environmentId === environmentId)?.tag ?? short(environmentId);
      console.log(
        `mesh ${local ? `${local.tag} ${local.label} (${local.environmentId})` : "?"} · ${result.layout.legacy ? "legacy layout (no meshLayout RPC)" : `${result.layout.entries} layout entries, revision ${result.layout.revision || "-"}`} · ${result.layout.workspaces} workspace(s) · ${result.layout.representations} representation(s)`,
      );
      for (const link of links)
        console.log(
          `  link ${link.status.padEnd(11)} ${tagOf(link.environmentId).padEnd(3)} ${link.label}  ${link.environmentId}  ${link.urls?.join(", ")}${link.lastReachedAt ? `  last ${ago(link.lastReachedAt)}` : ""}${link.lastError ? `  ${clip(link.lastError, 80)}` : ""}`,
        );
      if (!links.length)
        console.log(`  no links${linksError ? ` (${clip(linksError, 120)})` : ""}`);
      for (const row of rows)
        console.log(
          `  ${row.rep.role.padEnd(8)} ${tagOf(row.rep.environmentId).padEnd(3)} ${clip(row.rep.path || row.logicalKey, 48).padEnd(48)} ${replicaStateText(row)}`,
        );
      if (live.error && !live.disabled) console.log(`  replicas: ${clip(live.error, 160)}`);
      return;
    }
    if (sub === "link") {
      const known = await collectMachines();
      let machine;
      try {
        machine = resolveMachineRef(pos[1], known);
      } catch (error) {
        if (!/no machine/.test(error.message)) throw error;
        const ssh = opt.ssh || MACHINE_ALIASES.get(normalizeMachineName(pos[1])) || pos[1];
        const remote = parseJsonOutput(sshRun(ssh, ["env", "--json"]));
        if (!remote.environmentId) die("remote environment has no environment id");
        machine = { ...remote, sshAlias: ssh, urls: [], local: false };
      }
      if (machine.local) die(`${machine.label} is this machine; link another one`);
      const url = opt.url || machine.urls[0];
      if (!url)
        die(
          `no URL for ${machine.label}. Pass --url https://host:port (its T3 origin reachable from here)`,
        );
      const ssh = opt.ssh || machine.sshAlias;
      if (!ssh)
        die(
          `no ssh route to ${machine.label}. Pass --ssh user@host (or save a route in Settings › Machines)`,
        );
      const pairingCode = await remotePairingCode(ssh, opt.remoteBase);
      const link = await withWs((c) =>
        c.rpc(
          "peerLinks.link",
          buildMeshLinkInput({
            url,
            pairingCode,
            environmentId: machine.environmentId,
            label: machine.label,
            access: opt.access || "full-access",
          }),
        ),
      );
      if (opt.json) return json(link);
      console.log(
        `linked ${link.label} (${link.environmentId}) at ${link.urls.join(", ")} with ${link.access}`,
      );
      return;
    }
    if (sub === "unlink") {
      const machine = await getMachine(pos[1]);
      if (machine.local) die(`${machine.label} is this machine`);
      if (!opt.yes)
        die(
          `unlinks ${machine.label} here (its threads and projects stay on that machine). Re-run with --yes`,
        );
      const r = await withWs((c) =>
        c.rpc("peerLinks.unlink", { environmentId: machine.environmentId }),
      );
      if (opt.json) return json(r);
      console.log(r.removed ? `unlinked ${machine.label}` : `${machine.label} was not linked`);
      return;
    }
    die(
      "usage: t3ctl mesh status | mesh link <machine> [--url URL] [--ssh DEST] | mesh unlink <machine> --yes",
    );
  },

  async place(pos, opt) {
    if (!pos[0])
      die(
        "usage: t3ctl place <project> --on <machine> [--primary] [--source <machine>] [--path PATH] [--wait [dur]]",
      );
    if (!opt.on) die("place needs --on <machine>");
    const project = await resolveProject(pos[0]);
    const machine = await getMachine(opt.on);
    const tools = await (await mcp()).tools();
    if (!tools.some((t) => t.name === "t3_project_place"))
      die("this server has no t3_project_place (needs the mesh replica build); update the server");
    const source = opt.source ? (await getMachine(opt.source)).environmentId : undefined;
    const wait = waitSeconds(opt.wait);
    const input = buildPlaceInput({
      project: project.id,
      machine: machine.environmentId,
      role: opt.primary ? "primary" : undefined,
      source,
      path: opt.path ? (machine.local ? expandHome(opt.path) : String(opt.path)) : undefined,
      wait,
    });
    const r = await (await mcp()).call("t3_project_place", input);
    if (opt.json) return json(r);
    const rep = r.representation;
    console.log(
      `${rep ? `${rep.role} ${rep.transport} on ${machine.label} at ${rep.path}` : `removed from ${machine.label}`}  (${r.ready ? "ready" : "pending"}${rep?.projectId ? `, project ${short(rep.projectId)}` : ""})`,
    );
  },

  async unplace(pos, opt) {
    if (!pos[0]) die("usage: t3ctl unplace <project> --on <machine> --yes");
    if (!opt.on) die("unplace needs --on <machine>");
    const project = await resolveProject(pos[0]);
    const machine = await getMachine(opt.on);
    if (!opt.yes)
      die(
        `removes the representation of "${project.title}" on ${machine.label} (files and the registered project stay). Re-run with --yes`,
      );
    const tools = await (await mcp()).tools();
    if (!tools.some((t) => t.name === "t3_project_place"))
      die("this server has no t3_project_place (needs the mesh replica build); update the server");
    const r = await (
      await mcp()
    ).call(
      "t3_project_place",
      buildPlaceInput({ project: project.id, machine: machine.environmentId, action: "remove" }),
    );
    if (opt.json) return json(r);
    console.log(`removed "${project.title}" from ${machine.label} (files stay)`);
  },

  async replicas(pos, opt) {
    const layout = await layoutSnapshot();
    const live = await replicaLiveStatus();
    const rows = replicaRows(layout.config, live.replicas);
    const machines = new Map((await collectMachines({ layout })).map((m) => [m.environmentId, m]));
    const out = rows.map((row) => {
      const machine = machines.get(row.rep.environmentId);
      return {
        logicalKey: row.logicalKey,
        machine: machine?.label ?? row.rep.environmentId,
        tag: machine?.tag ?? defaultMachineTag(row.rep.environmentId, row.rep.environmentId),
        environmentId: row.rep.environmentId,
        role: row.rep.role,
        transport: row.rep.transport,
        path: row.rep.path,
        source: row.rep.source ?? null,
        projectId: row.rep.projectId ?? null,
        state: row.live?.state ?? row.status?.state ?? (row.rep.projectId ? "watching" : "pending"),
        progress: row.live?.progress ?? null,
        conflicts: row.live?.conflicts ?? [],
        problem: row.live?.problems ?? [],
        message: row.live?.message ?? row.status?.message ?? null,
        sessionName: row.live?.sessionName ?? null,
      };
    });
    if (opt.json)
      return json({
        replicas: out,
        disabled: live.disabled,
        error: live.disabled ? null : live.error,
        legacy: layout.legacy,
      });
    if (!out.length) console.log(`no representations${layout.legacy ? " (legacy layout)" : ""}`);
    for (const row of out) {
      const conflict = row.conflicts.length ? `  ${row.conflicts.length} conflict(s)` : "";
      console.log(
        `${String(row.tag).padEnd(3)} ${String(row.machine).padEnd(16)} ${row.role.padEnd(8)} ${row.state.padEnd(10)}${row.progress !== null && row.progress !== undefined ? ` ${Math.round(row.progress * 100)}%` : ""}  ${clip(row.logicalKey, 36)}  ${row.path}${conflict}${row.message ? ` — ${clip(row.message, 80)}` : ""}`,
      );
    }
    if (live.disabled) console.log("replicas are disabled on this server");
    else if (live.error) console.log(`replicas: ${clip(live.error, 200)}`);
  },

  async replica(pos, opt) {
    const sub = pos[0];
    if (sub !== "retry") die("usage: t3ctl replica retry <project> --on <machine>");
    if (!pos[1]) die("usage: t3ctl replica retry <project> --on <machine>");
    if (!opt.on) die("replica retry needs --on <machine>");
    const project = await resolveProject(pos[1]);
    const machine = await getMachine(opt.on);
    const layout = await layoutSnapshot();
    const normalize = (p) => String(p).replaceAll("\\", "/").replace(/\/+$/, "");
    const entries = Object.entries(layout.config.projectMounts ?? {});
    const logicalKey =
      entries.find(([, reps]) => reps.some((rep) => rep.projectId === project.id))?.[0] ??
      entries.find(([, reps]) =>
        reps.some(
          (rep) =>
            rep.environmentId === layout.environmentId &&
            normalize(rep.path) === normalize(project.workspaceRoot),
        ),
      )?.[0];
    if (!logicalKey) die(`no representation found for "${project.title}" in the layout`);
    const rep = layout.config.projectMounts[logicalKey].find(
      (r) => r.environmentId === machine.environmentId,
    );
    if (!rep || !rep.source) die("the selected representation is not a replica");
    const driverId = layout.config.machines?.[rep.environmentId]?.reach?.[rep.source]?.ssh
      ? rep.environmentId
      : layout.config.machines?.[rep.source]?.reach?.[rep.environmentId]?.ssh
        ? rep.source
        : null;
    if (!driverId) die("no ssh route between replica and primary; configure Settings › Machines");
    const input = { logicalKey, environmentId: machine.environmentId };
    const driver = await getMachine(driverId);
    const r = driver.local
      ? await withWs((c) => c.rpc("replicas.retry", input))
      : parseJsonOutput(
          sshRun(driver.sshAlias || die("no ssh route to the replica driver"), [
            "rpc",
            "replicas.retry",
            JSON.stringify(input),
          ]),
        );
    if (opt.json) return json(r);
    console.log(
      `retry requested for ${clip(logicalKey, 40)} on ${machine.label}: ${r.state}${r.message ? ` — ${r.message}` : ""}`,
    );
  },

  async layout(pos, opt) {
    const sub = pos[0] || "get";
    if (sub === "get") {
      const layout = await layoutSnapshot();
      if (opt.json) return json(layout);
      console.log(
        `${layout.legacy ? "legacy settings layout (no meshLayout RPC)" : `mesh layout, ${Object.keys(layout.document ?? {}).length} entries`} · environment ${layout.environmentId}`,
      );
      console.log(
        `workspaces: ${(layout.config.workspaces ?? []).map((w) => `${w.name} (${w.id})`).join(", ") || "none"}`,
      );
      console.log(
        `default: ${layout.config.defaultWorkspace ?? "-"} · rules ${layout.config.rules?.length ?? 0} · machines ${Object.keys(layout.config.machines ?? {}).length} · logical projects ${Object.keys(layout.config.projectMounts ?? {}).length}`,
      );
      for (const [key, reps] of Object.entries(layout.config.projectMounts ?? {}))
        console.log(
          `  ${clip(key, 50)}: ${reps.map((r) => `${r.role}@${short(r.environmentId)} ${r.path}`).join("; ")}`,
        );
      if (layout.legacyReason) console.log(`(${layout.legacyReason})`);
      return;
    }
    if (sub === "merge") {
      const refs = (Array.isArray(opt.from) ? opt.from : opt.from ? [opt.from] : [])
        .flatMap((v) => String(v).split(","))
        .map((v) => v.trim())
        .filter(Boolean);
      if (!refs.length)
        die("usage: t3ctl layout merge --from <machine[,machine]> [--dry-run | --apply]");
      if (opt.apply && opt.dryRun) die("use either --dry-run or --apply");
      const apply = Boolean(opt.apply);
      const machines = await collectMachines();
      const localLayout = await layoutSnapshot();
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
      mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(BACKUP_DIR, `${stamp}-target-${randomUUID()}.json`),
        JSON.stringify(localLayout, null, 2),
        { mode: 0o600 },
      );
      const sources = [];
      for (const ref of refs) {
        const machine = resolveMachineRef(ref, machines);
        let fetched;
        if (machine.local) fetched = { document: localLayout.document, config: localLayout.config };
        else {
          const destination = opt.ssh && refs.length === 1 ? opt.ssh : machine.sshAlias;
          if (!destination) die(`no ssh route to ${machine.label}. Pass --ssh user@host`);
          fetched = await remoteLayout(destination);
          if (!fetched)
            die(`could not read the layout of ${machine.label} over ssh ${destination}`);
        }
        const file = join(
          BACKUP_DIR,
          `${stamp}-${randomUUID()}-${machine.label.replace(/[^a-z0-9._-]+/gi, "-") || short(machine.environmentId)}.json`,
        );
        writeFileSync(
          file,
          JSON.stringify(
            {
              environmentId: machine.environmentId,
              label: machine.label,
              config: fetched.config,
              document: fetched.document,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        const entries =
          fetched.document ?? importLegacyEntries(fetched.config, machine.environmentId);
        sources.push({ machine, entries, legacy: !fetched.document, backup: file });
      }
      // Preview the CRDT merge locally (same per-key LWW rule).
      const merged = { ...localLayout.document };
      for (const source of sources) {
        for (const [key, entry] of Object.entries(source.entries)) {
          const old = merged[key];
          if (
            !old ||
            entry.h > old.h ||
            (entry.h === old.h && JSON.stringify(entry.v) > JSON.stringify(old.v))
          )
            merged[key] = entry;
        }
      }
      if (!apply) {
        console.log(`dry run: ${sources.length} source(s), nothing applied (add --apply)`);
        for (const source of sources)
          console.log(
            `  ${source.machine.tag} ${source.machine.label}: ${source.legacy ? "legacy config → zero-clock entries" : "mesh document"}, ${Object.keys(source.entries).length} entries; backup ${source.backup}`,
          );
        console.log(
          `  merged document: ${Object.keys(merged).length} entries (was ${Object.keys(localLayout.document ?? {}).length})`,
        );
        return;
      }
      let snapshot = null;
      for (const source of sources)
        snapshot = await withWs((c) => c.rpc("meshLayout.apply", { entries: source.entries }));
      if (opt.json)
        return json({
          applied: sources.map((s) => ({
            environmentId: s.machine.environmentId,
            entries: Object.keys(s.entries).length,
            backup: s.backup,
          })),
          snapshot,
        });
      console.log(
        `applied ${sources.length} source(s): ${snapshot ? Object.keys(snapshot.document).length : "?"} layout entries, ${snapshot?.config?.workspaces?.length ?? "?"} workspace(s)`,
      );
      for (const source of sources)
        console.log(
          `  ${source.machine.label}: ${Object.keys(source.entries).length} entries from ${source.legacy ? "legacy config" : "mesh document"} (backup ${source.backup})`,
        );
      return;
    }
    die("usage: t3ctl layout get | layout merge --from <machine[,machine]> [--dry-run | --apply]");
  },

  async threads(pos, opt) {
    const filter = {};
    if (opt.status) filter.statuses = String(opt.status).split(",");
    if (opt.settled) filter.settled = true;
    if (opt.snoozed) filter.snoozed = true;
    if (opt.subagents) filter.includeSubagents = true;
    if (opt.match) filter.titleContains = String(opt.match);
    if (opt.all) {
      if (opt.archived)
        die(
          "archived threads are per machine: drop --all (archives live on the machine that owns them)",
        );
      const machines = await queryableMachines();
      const words = opt.project
        ? String(opt.project).toLowerCase().split(/\s+/).filter(Boolean)
        : null;
      let rows = await threadsAcrossMachines(machines, filter, words);
      rows = rows.slice(0, Number(opt.limit || 40));
      if (opt.json) return json(rows);
      for (const t of rows) console.log(threadLine(t));
      if (!rows.length) console.log("(no threads)");
      return;
    }
    const projects = await listProjects();
    const scope = opt.project ? [await resolveProject(opt.project, projects)] : projects;
    let rows = opt.archived
      ? (await archivedThreads()).filter((t) => scope.some((p) => p.id === t.projectId))
      : await listThreads(scope, filter);
    rows = rows.slice(0, Number(opt.limit || 40));
    if (opt.json) return json(rows);
    for (const t of rows) console.log(threadLine(t));
    if (!rows.length) console.log("(no threads)");
  },

  async status(pos, opt) {
    const local = opt.all ? await localEnvironment() : null;
    let rows;
    if (opt.all) {
      const machines = await queryableMachines();
      rows = await threadsAcrossMachines(machines, { includeSubagents: Boolean(opt.subagents) });
      if (opt.project) {
        const words = String(opt.project).toLowerCase().split(/\s+/).filter(Boolean);
        rows = rows.filter((t) =>
          words.every((w) => `${t.project} ${t.projectId}`.toLowerCase().includes(w)),
        );
      }
    } else {
      const projects = await listProjects();
      const scope = opt.project ? [await resolveProject(opt.project, projects)] : projects;
      rows = await listThreads(scope, { includeSubagents: Boolean(opt.subagents) });
    }
    const since = Date.now() - parseDuration(`${opt.hours || 24}h`);
    const recent = rows.filter(
      (t) =>
        Date.parse(t.updatedAt) >= since ||
        ["running", "starting", "preparing", "queued", "waiting"].includes(t.status),
    );
    // the list has no pending-request count; read the live ones to catch approvals and questions
    const m = await mcp();
    await Promise.all(
      recent
        .filter((t) => ["running", "waiting", "starting"].includes(t.status))
        .map(async (t) => {
          const environmentId =
            t.environmentId && local && t.environmentId !== local.environmentId
              ? { environmentId: t.environmentId }
              : {};
          try {
            t.pendingRequestCount = (
              await m.call("t3_thread_read", { threadId: t.threadId, limit: 1, ...environmentId })
            ).thread.pendingRequestCount;
          } catch {
            /* keep list data */
          }
        }),
    );
    const groups = {
      "needs you (waiting / pending requests)": [],
      working: [],
      failed: [],
      "done (recent)": [],
      other: [],
    };
    for (const t of recent) {
      if (t.status === "waiting" || t.pendingRequestCount)
        groups["needs you (waiting / pending requests)"].push(t);
      else if (["running", "starting", "preparing", "queued"].includes(t.status))
        groups.working.push(t);
      else if (["failed", "interrupted", "cancelled"].includes(t.status)) groups.failed.push(t);
      else if (t.status === "completed") groups["done (recent)"].push(t);
      else groups.other.push(t);
    }
    if (opt.json) return json(groups);
    for (const [k, list] of Object.entries(groups)) {
      if (!list.length) continue;
      console.log(`\n${k}: ${list.length}`);
      for (const t of list.slice(0, 25)) console.log(`  ${threadLine(t)}`);
    }
    if (!recent.length) console.log(`nothing active or updated in the last ${opt.hours || 24}h`);
  },

  async self() {
    if (!process.env.T3_MCP_URL || !process.env.T3_MCP_BEARER_TOKEN)
      return console.log(
        "t3ctl self needs a thread-scoped T3_MCP_URL and T3_MCP_BEARER_TOKEN. An agent can call t3_thread_self directly; outside clients have no calling thread.",
      );
    const scoped = new Mcp(new URL(process.env.T3_MCP_URL).origin);
    scoped.token = {
      resource: process.env.T3_MCP_URL,
      accessToken: process.env.T3_MCP_BEARER_TOKEN,
    };
    await scoped.init();
    return json(await scoped.call("t3_thread_self", {}));
  },

  async show(pos, opt) {
    const t =
      opt.archived && !opt.on
        ? await resolveThread(pos[0], { projectRef: opt.project, includeArchived: true })
        : await resolveThreadAcross(pos[0], { on: opt.on });
    const view = opt.activity ? "activity" : "messages";
    const data = await readAll(t.threadId, {
      environmentId: t.environmentId,
      view,
      maxCharsPerItem: opt.full ? 50000 : 4000,
      expand: opt.full ? "all" : false,
    });
    if (opt.json) return json(data);
    const th = data.thread;
    console.log(
      `${th.title}\n  id ${th.threadId}  project ${th.projectId}\n  ${th.status}${th.pendingRequestCount ? `, ${th.pendingRequestCount} pending request(s)` : ""}  ·  ${th.providerInstanceId}:${th.model}  ·  ${th.runtimeMode}${th.interactionMode === "plan" ? " · plan" : ""}  ·  ${th.runCount} run(s)  ·  updated ${ago(th.updatedAt)}`,
    );
    if (th.branch || th.worktreePath)
      console.log(`  branch ${th.branch ?? "-"}  worktree ${th.worktreePath ?? "-"}`);
    if (th.archived || th.settled || th.snoozed)
      console.log(
        `  ${[th.archived && "archived", th.settled && "settled", th.snoozed && `snoozed until ${th.snoozedUntil}`].filter(Boolean).join(", ")}`,
      );
    const n = opt.messages !== undefined ? Number(opt.messages) : opt.full ? 1e9 : 10;
    const items = n > 0 ? data.items.slice(-n) : [];
    for (const it of items) {
      const label = ITEM_LABEL[it.type] ?? it.type;
      const text = opt.full ? it.text : clip(it.text ?? it.title ?? "", opt.activity ? 300 : 1200);
      console.log(
        `\n── ${label}${it.status && it.status !== "completed" ? ` (${it.status})` : ""}${it.title && it.text ? `: ${it.title}` : ""}\n${text ?? ""}`,
      );
    }
    if (!opt.full && data.items.length > items.length)
      console.log(`\n(${data.items.length - items.length} earlier items: --messages N or --full)`);
  },

  async output(pos, opt) {
    const t = await resolveThread(pos[0], {
      projectRef: opt.project,
      includeArchived: opt.archived,
    });
    const data = await readAll(t.threadId, { expand: isLastAnswer });
    const last = [...data.items]
      .reverse()
      .find((i) => i.type === "assistant_message" || i.type === "proposed_plan");
    if (opt.json) return json(last ?? null);
    if (!last) die(`no agent output yet in "${t.title}" (status ${data.thread.status})`);
    console.log(last.text);
  },

  async search(pos, opt) {
    const query = pos.join(" ");
    if (!query) die('usage: t3ctl search "words" [--project P] [--limit N]');
    const args = { query, limit: Number(opt.limit || 20) };
    if (opt.project) args.projectId = (await resolveProject(opt.project)).id;
    const r = await (await mcp()).call("t3_thread_search", args);
    if (opt.json) return json(r);
    for (const x of r.matches ?? r.threads ?? r.results ?? [])
      console.log(
        `${x.threadId}  ${clip(x.title, 60)}  ${clip(x.snippet ?? x.matchText ?? "", 80)}`,
      );
  },

  async find(pos, opt) {
    const query = pos.join(" ");
    if (!query) die('usage: t3ctl find "words" [--all | --on <machine>] [--limit N]');
    const limit = Number(opt.limit || 20);
    const machines = opt.on ? [await getMachine(opt.on)] : await queryableMachines();
    const m = await mcp();
    const matches = [];
    const skipped = [];
    // Newer servers answer `environmentId: "all"`; older ones are fanned out over the links.
    if (!opt.on && machines.length > 1) {
      try {
        const all = await m.call("t3_thread_search", { query, limit, environmentId: "all" });
        if (Array.isArray(all?.matches)) matches.push(...all.matches);
      } catch {
        /* fan out below */
      }
    }
    if (!matches.length) {
      for (const machine of machines) {
        try {
          const r = await m.call("t3_thread_search", {
            query,
            limit,
            ...(machine.local ? {} : { environmentId: machine.environmentId }),
          });
          for (const x of r.matches ?? [])
            matches.push({
              ...x,
              environmentId: machine.environmentId,
              machineLabel: machine.label,
              machineTag: machine.tag,
            });
        } catch (error) {
          skipped.push(
            `${machine.label}: ${clip(error instanceof Fail ? error.message : String(error), 140)}`,
          );
        }
      }
    } else {
      for (const x of matches) {
        const machine = machines.find((mm) => mm.environmentId === x.environmentId);
        if (machine) {
          x.machineLabel = machine.label;
          x.machineTag = machine.tag;
        }
      }
    }
    if (opt.json) return json({ matches, skipped });
    if (!matches.length) console.log(`no matches for "${query}"`);
    for (const x of matches)
      console.log(
        `${String(x.machineTag ?? "??").padEnd(3)} ${x.threadId}  ${clip(x.title, 60)}  ${clip(x.snippet ?? x.matchText ?? "", 80)}`,
      );
    for (const s of skipped) console.error(`skipped ${s}`);
  },

  async open(pos, opt) {
    if (!pos[0]) die("usage: t3ctl open <thread> [--on <machine>]");
    const t = await resolveThreadAcross(pos[0], { on: opt.on });
    const { origin } = serverInfo();
    if (!t.environmentId) {
      const page = await (
        await mcp()
      ).call("t3_thread_list", { environmentId: "all", allProjects: true, limit: 100 });
      const found = page.threads.find((row) => row.threadId === t.threadId);
      t.environmentId =
        found?.environmentId ?? (await collectMachines()).find((m) => m.local)?.environmentId;
    }
    const machine = (await collectMachines()).find((m) => m.environmentId === t.environmentId);
    const webUrl = threadWebUrl(origin, t.environmentId, t.threadId);
    const deepLink = threadDeepLink(t.environmentId, t.threadId);
    const ui = await tryUiOpen(
      buildUiOpenTarget({ kind: "thread", threadId: t.threadId, environmentId: t.environmentId }),
    );
    if (opt.json)
      return json({
        environmentId: t.environmentId,
        threadId: t.threadId,
        title: t.title,
        machine: machine?.label ?? null,
        tag: machine?.tag ?? null,
        webUrl,
        deepLink,
        clients: ui.clients,
        note: ui.note,
      });
    console.log(`${t.title}  [${machine?.tag ?? "??"}] ${t.threadId}`);
    console.log(`web:   ${webUrl}`);
    console.log(`link:  ${deepLink}`);
    if (ui.clients !== null) console.log(`opened on ${ui.clients} client(s)`);
    if (ui.note) console.log(ui.note);
  },

  async "open-file"(pos, opt) {
    if (!pos[0]) die("usage: t3ctl open-file <path> [--on <machine>] [--line N]");
    const machine = opt.on
      ? await getMachine(opt.on)
      : (await collectMachines()).find((m) => m.local);
    let path = String(pos[0]);
    if (!path.startsWith("/") && !path.startsWith("~/")) {
      if (!machine.local)
        die("a relative path is only meaningful on this machine; pass an absolute path with --on");
      path = resolve(process.cwd(), path);
    }
    const line = opt.line ? Number(opt.line) : undefined;
    const link = fileDeepLink(machine.environmentId, path, line);
    const ui = await tryUiOpen(
      buildUiOpenTarget({ kind: "file", path, line, environmentId: machine.environmentId }),
    );
    if (opt.json)
      return json({
        environmentId: machine.environmentId,
        machine: machine.label,
        tag: machine.tag,
        path,
        line: line ?? null,
        link,
        clients: ui.clients,
        note: ui.note,
      });
    console.log(`${path}${line ? `:${line}` : ""}  [${machine.tag}] ${machine.label}`);
    console.log(`link:  ${link}`);
    if (ui.clients !== null) console.log(`opened on ${ui.clients} client(s)`);
    if (ui.note) console.log(ui.note);
  },

  async cat(pos, opt) {
    if (!pos[0]) die("usage: t3ctl cat <path> [--on <machine>]");
    const machine = opt.on
      ? await getMachine(opt.on)
      : (await collectMachines()).find((m) => m.local);
    let path = String(pos[0]);
    if (!path.startsWith("/") && !path.startsWith("~/")) {
      if (!machine.local)
        die("a relative path is only meaningful on this machine; pass an absolute path with --on");
      path = resolve(process.cwd(), path);
    }
    const r = await withWs((c) =>
      c.rpc("files.read", {
        absolutePath: path,
        ...(machine.local ? {} : { environmentId: machine.environmentId }),
      }),
    );
    if (opt.json) return json(r);
    process.stdout.write(r.contents);
    if (r.truncated)
      console.error(
        `\nt3ctl: preview only (${r.byteLength} bytes on ${machine.label}); read the rest there`,
      );
  },

  async wait(pos, opt) {
    const t = await resolveThreadAcross(pos[0], { on: opt.on });
    const r = await waitThread(
      t.threadId,
      opt.timeout ? parseDuration(opt.timeout) : 30 * 6e4,
      t.environmentId,
    );
    if (opt.json) return json(r);
    console.log(`${t.title}: ${r.status}${r.timedOut ? " (timed out, still running)" : ""}`);
  },

  async new(pos, opt) {
    const message = readMessage(pos, opt);
    const args = { runtimeMode: runtimeMode(opt), interactionMode: opt.plan ? "plan" : "default" };
    args.modelSelection = await modelSelection(opt);
    const target = opt.on ? await getMachine(opt.on) : null;
    const remoteTarget = target && !target.local ? target : null;
    if (remoteTarget) {
      args.environmentId = remoteTarget.environmentId;
      if (opt.cwd)
        die(
          "--cwd is a path on this machine; for another machine use --worktree or leave the checkout to T3",
        );
    }
    if (opt.scratch || (!opt.project && !opt.cwd)) args.scratch = true;
    else {
      const projects = await listProjects();
      const p = opt.project
        ? await resolveProject(opt.project, projects)
        : projects.find((x) => x.workspaceRoot === expandHome(opt.cwd));
      if (!p)
        die(`--cwd ${opt.cwd} is not a project; pass --project or add it (t3ctl project-add)`);
      args.projectId = p.id;
      if (remoteTarget) {
        const tools = await (await mcp()).tools();
        let existing = null;
        if (tools.some((t) => t.name === "t3_project_machines")) {
          try {
            const known = await (await mcp()).call("t3_project_machines", { project: p.id });
            existing =
              known.representations.find(
                (rep) => rep.environmentId === remoteTarget.environmentId,
              ) ?? null;
          } catch {
            /* fall through to place, which reports the real error */
          }
        }
        if (existing?.projectId) args.projectId = existing.projectId;
        else if (tools.some((t) => t.name === "t3_project_place")) {
          if (!opt.json)
            console.error(`t3ctl: placing "${p.title}" on ${remoteTarget.label} and waiting…`);
          const placed = await (
            await mcp()
          ).call("t3_project_place", {
            project: p.id,
            machine: remoteTarget.environmentId,
            wait: 600,
          });
          if (!placed.ready && !placed.representation?.projectId)
            die(`the replica of "${p.title}" on ${remoteTarget.label} did not become ready`);
          if (placed.representation?.projectId) args.projectId = placed.representation.projectId;
          if (!opt.json)
            console.log(
              `placed "${p.title}" on ${remoteTarget.label} (${placed.ready ? "ready" : "pending"})`,
            );
        }
      }
      if (opt.worktree)
        args.workspaceStrategy = {
          type: "worktree",
          baseRef: opt.base || "HEAD",
          ...(opt.worktree !== true && opt.worktree !== "auto"
            ? { branch: String(opt.worktree) }
            : {}),
          startFromOrigin: Boolean(opt.fromOrigin),
        };
      else if (opt.cwd && expandHome(opt.cwd) !== p.workspaceRoot)
        args.workspaceStrategy = {
          type: "existing_worktree",
          worktreePath: expandHome(opt.cwd),
          ...(opt.branch ? { branch: opt.branch } : {}),
        };
      else if (opt.branch) args.workspaceStrategy = { type: "root", branch: opt.branch };
    }
    // The server needs a title up front (it can regenerate one from the message).
    args.title = opt.title
      ? String(opt.title)
      : message.trim().split("\n")[0].slice(0, 60).trim() || "New thread";
    if (message.trim()) args.message = message;
    if (opt.attach) args.attachments = await uploadAttachments(opt.attach);
    const r = await (await mcp()).call("t3_thread_launch", args);
    if (opt.json && !opt.wait) return json(r);
    console.log(
      `started thread ${r.threadId}${opt.title ? ` "${opt.title}"` : ""} · ${r.modelSelection?.instanceId}:${r.modelSelection?.model} · ${r.status}${remoteTarget ? ` on ${remoteTarget.label}` : ""}`,
    );
    if (opt.wait) await waitAndPrint(r.threadId, { ...opt, environmentId: args.environmentId });
  },

  async send(pos, opt) {
    const t = await resolveThreadAcross(pos[0], { on: opt.on });
    const message = readMessage(pos.slice(1), opt);
    const m = await mcp();
    if (opt.attach) {
      const attachments = await uploadAttachments(opt.attach);
      await m.call("t3_thread_send_attachments", {
        threadId: t.threadId,
        attachments,
        ...(message.trim() ? { message } : {}),
      });
    } else {
      if (!message.trim()) die("message is empty");
      const mode = opt.queue
        ? "queue"
        : opt.steer
          ? "steer"
          : opt.restart
            ? "restart"
            : opt.sendMode || undefined;
      await m.call("t3_thread_send", { threadId: t.threadId, message, ...(mode ? { mode } : {}) });
    }
    if (!opt.wait) console.log(`sent to ${t.threadId} "${t.title}"`);
    else await waitAndPrint(t.threadId, opt);
  },

  async stop(pos, opt) {
    const t = await resolveThreadAcross(pos[0], { on: opt.on });
    const r = await (
      await mcp()
    ).call("t3_thread_interrupt", {
      threadId: t.threadId,
      ...(opt.reason ? { reason: String(opt.reason) } : {}),
    });
    if (opt.json) return json(r);
    console.log(`interrupt requested for "${t.title}"`);
  },

  async requests(pos, opt) {
    const t = await resolveThreadAcross(pos[0], { on: opt.on });
    const pending = await pendingRequests(t.threadId);
    if (opt.json) return json(pending);
    if (!pending.length) return console.log(`no pending requests in "${t.title}"`);
    for (const p of pending) {
      if (p.kind === "approval") {
        console.log(
          `approval  ${clip(p.text, 600)}\n  → t3ctl approve ${t.threadId} accept|decline   (request ${p.requestId})`,
        );
        continue;
      }
      console.log(`question  (request ${p.requestId})`);
      for (const q of p.questions)
        console.log(
          `  [${q.id}] ${q.question}${q.multiSelect ? " (multi)" : ""}${(q.options || []).length ? `\n     options: ${q.options.map((o) => o.label).join(" | ")}` : ""}`,
        );
      console.log(
        `  → t3ctl answer ${t.threadId} "<answer>"${p.questions.length > 1 ? ' "<answer 2>" …' : ""}`,
      );
    }
  },

  async approve(pos, opt) {
    const t = await resolveThread(pos[0], { projectRef: opt.project });
    const decision = pos[1] || "accept";
    if (!["accept", "acceptForSession", "acceptAlways", "decline", "cancel"].includes(decision))
      die("decision: accept | acceptForSession | acceptAlways | decline | cancel");
    const pending = (await pendingRequests(t.threadId)).filter(
      (p) => p.kind === "approval" && (!opt.request || p.requestId === opt.request),
    );
    if (!pending.length) return console.log(`no pending approvals in "${t.title}"`);
    await withWs(async (c) => {
      for (const p of pending)
        await c.dispatch({
          type: "runtime-request.respond",
          threadId: t.threadId,
          requestId: p.requestId,
          decision,
        });
    });
    console.log(`${decision}: ${pending.length} approval(s) in "${t.title}"`);
  },

  async answer(pos, opt) {
    const t = await resolveThreadAcross(pos[0], { on: opt.on });
    const questions = (await pendingRequests(t.threadId)).filter(
      (p) => p.kind === "question" && (!opt.request || p.requestId === opt.request),
    );
    if (!questions.length) return console.log(`no pending questions in "${t.title}"`);
    const req = questions[0];
    let answers;
    if (opt.answers) answers = readJsonArg(opt.answers);
    else {
      const given = pos.slice(1);
      if (!given.length)
        die(
          `usage: t3ctl answer <T> "answer" ["answer 2" …] | --answers '{"<questionId>": "…"}'  (see t3ctl requests)`,
        );
      answers = {};
      req.questions.forEach((q, i) => {
        const raw = given[i] ?? given[given.length - 1];
        const pick = (v) =>
          (q.options || []).find((o) => o.label.toLowerCase() === String(v).trim().toLowerCase())
            ?.label ?? String(v);
        answers[q.id] = q.multiSelect ? String(raw).split(",").map(pick) : pick(raw);
      });
    }
    await pendingRequest("respond", { threadId: t.threadId, requestId: req.requestId, answers });
    console.log(
      `answered in "${t.title}": ${Object.entries(answers)
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`)
        .join("  ")}`,
    );
  },

  async fork(pos, opt) {
    const t = await resolveThread(pos[0], { projectRef: opt.project });
    const m = await mcp();
    const args = {
      action: "fork",
      threadId: t.threadId,
      sourcePoint: opt.run
        ? { type: "run", runId: opt.run }
        : opt.checkpoint
          ? { type: "checkpoint", checkpointId: opt.checkpoint }
          : { type: "latest_stable" },
      ...(opt.title ? { title: String(opt.title) } : {}),
    };
    const r = await m.call("t3_thread_transfer", args);
    const id = r.targetThreadId ?? r.threadId ?? r.forkThreadId;
    if (opt.agent || opt.model || opt.effort)
      await m.call("t3_thread_configure", {
        threadId: id,
        modelSelection: await modelSelection(opt),
      });
    const message = opt.message
      ? String(opt.message)
      : opt.file
        ? readFileSync(expandHome(opt.file), "utf8")
        : "";
    if (message) await m.call("t3_thread_send", { threadId: id, message });
    if (opt.json) return json(r);
    console.log(
      `forked "${t.title}" → ${id}${opt.title ? ` "${opt.title}"` : ""}${message ? " (message sent)" : ""}`,
    );
  },

  async rename(pos, opt) {
    const t = await resolveThread(pos[0], { projectRef: opt.project, includeArchived: true });
    const title = pos.slice(1).join(" ");
    const m = await mcp();
    if (!title || opt.auto) {
      await m.call("t3_thread_update", { threadId: t.threadId, action: "regenerate_title" });
      return console.log(`title regeneration requested for ${t.threadId}`);
    }
    await m.call("t3_thread_update", { threadId: t.threadId, action: "rename", title });
    console.log(`renamed "${t.title}" → "${title}"`);
  },

  async snooze(pos, opt) {
    const t = await resolveThread(pos[0], { projectRef: opt.project });
    const until = opt.until
      ? new Date(opt.until).toISOString()
      : new Date(Date.now() + parseDuration(opt.for || "2h")).toISOString();
    await (
      await mcp()
    ).call("t3_thread_organize", { threadId: t.threadId, action: "snooze", snoozedUntil: until });
    console.log(`snoozed "${t.title}" until ${until}`);
  },

  async unread(pos, opt) {
    const t = await resolveThread(pos[0], { projectRef: opt.project });
    await (await mcp()).call("t3_thread_organize", { threadId: t.threadId, action: "mark_unread" });
    console.log(`marked unread: "${t.title}"`);
  },

  async "set-model"(pos, opt) {
    const t = await resolveThread(pos[0], { projectRef: opt.project });
    const sel = await modelSelection(opt);
    await (await mcp()).call("t3_thread_configure", { threadId: t.threadId, modelSelection: sel });
    console.log(
      `"${t.title}" → ${sel.instanceId}:${sel.model}${sel.options ? ` ${sel.options.map((o) => `${o.id}=${o.value}`).join(" ")}` : ""}`,
    );
  },

  async "set-mode"(pos, opt) {
    const t = await resolveThread(pos[0], { projectRef: opt.project });
    const mode = pos[1];
    await withWs(async (c) => {
      if (mode === "plan" || mode === "default")
        await c.dispatch({
          type: "thread.interaction-mode.set",
          threadId: t.threadId,
          interactionMode: mode,
        });
      else if (RUNTIME_MODES.includes(mode))
        await c.dispatch({
          type: "thread.runtime-mode.set",
          threadId: t.threadId,
          runtimeMode: mode,
        });
      else die(`mode: ${RUNTIME_MODES.join(" | ")} | plan | default`);
    });
    console.log(`"${t.title}" → ${mode}`);
  },

  async delete(pos, opt) {
    const t = await resolveThread(pos[0], { projectRef: opt.project, includeArchived: true });
    if (!opt.yes)
      die(
        `this permanently deletes "${t.title}" (${t.threadId}). Prefer archive. Re-run with --yes`,
      );
    await withWs((c) => c.dispatch({ type: "thread.delete", threadId: t.threadId }));
    console.log(`deleted "${t.title}"`);
  },

  async bulk(pos, opt) {
    const action = pos[0];
    const actions = ["archive", "unarchive", "settle", "unsettle", "pin", "unpin", "delete"];
    if (!actions.includes(action))
      die(
        `usage: t3ctl bulk <${actions.join("|")}> [--project P] [--match words] [--status completed,failed] [--older-than 7d] [--yes]`,
      );
    const projects = await listProjects();
    const scope = opt.project ? [await resolveProject(opt.project, projects)] : projects;
    let rows =
      action === "unarchive" || (action === "delete" && opt.archived)
        ? (await archivedThreads()).filter((t) => scope.some((p) => p.id === t.projectId))
        : await listThreads(scope);
    if (opt.match) {
      const w = String(opt.match).toLowerCase().split(/\s+/);
      rows = rows.filter((t) => w.every((x) => t.title.toLowerCase().includes(x)));
    }
    if (opt.status) {
      const s = String(opt.status).split(",");
      rows = rows.filter((t) => s.includes(t.status) || (s.includes("settled") && t.settled));
    }
    if (opt.olderThan) {
      const cut = Date.now() - parseDuration(opt.olderThan);
      rows = rows.filter((t) => Date.parse(t.updatedAt) < cut);
    }
    rows = rows.filter((t) => !["running", "starting", "preparing", "queued"].includes(t.status));
    console.log(
      `${action}: ${rows.length} thread(s) match${opt.yes ? "" : " (dry run; add --yes to apply)"}`,
    );
    for (const t of rows.slice(0, opt.yes ? 0 : 15)) console.log(`  ${threadLine(t)}`);
    if (!opt.yes || !rows.length) return;
    if (action === "delete")
      await withWs(async (c) => {
        for (const t of rows) await c.dispatch({ type: "thread.delete", threadId: t.threadId });
      });
    else {
      const m = await mcp();
      for (const t of rows) await m.call("t3_thread_organize", { threadId: t.threadId, action });
    }
    console.log(`done: ${action} × ${rows.length}`);
  },

  async worktrees(pos, opt) {
    const t = await resolveThread(pos[0], { projectRef: opt.project });
    const r = await (
      await mcp()
    ).call("t3_worktree_list", {
      threadId: t.threadId,
      limit: 200,
      ...(opt.query ? { query: opt.query } : {}),
      ...(opt.remote ? { refKind: "all" } : { refKind: "local" }),
    });
    if (opt.json) return json(r);
    for (const x of r.refs ?? r.items ?? [])
      console.log(
        `${String(x.name ?? x.ref).padEnd(40)} ${x.worktreePath ?? x.checkoutPath ?? ""}`,
      );
  },

  async queue(pos, opt) {
    const t = await resolveThread(pos[0], { projectRef: opt.project });
    const r = await (await mcp()).call("t3_queue_list", { threadId: t.threadId });
    json(r);
  },

  async ws(pos, opt) {
    const sub = pos[0] || "list";
    await withWs(async (c) => {
      if (sub === "list" || sub === "ls") {
        const cfg = (await getSettings(c)).sidebarWorkspaces;
        const projects = await listProjects();
        if (opt.json)
          return json({
            config: cfg,
            projects: await Promise.all(
              projects.map(async (p) => {
                const key = await projectKey(p);
                const all = workspacesOf(cfg, key, p.workspaceRoot, isScratch(p));
                return {
                  id: p.id,
                  title: p.title,
                  key,
                  workspace: all[0] ?? null,
                  workspaces: all,
                };
              }),
            ),
          });
        for (const w of cfg.workspaces) {
          const mine = [];
          for (const p of projects)
            if (
              workspacesOf(cfg, await projectKey(p), p.workspaceRoot, isScratch(p)).includes(w.id)
            )
              mine.push(p.title);
          console.log(
            `${w.id.padEnd(18)} ${(w.icon ?? "").padEnd(3)} ${w.name}${w.color ? `  ${w.color}` : ""}${(cfg.defaultWorkspace ?? cfg.workspaces[0]?.id) === w.id ? "  (default)" : ""}\n    ${mine.join(", ") || "(no projects)"}`,
          );
        }
        if (cfg.rules.length)
          console.log(`rules: ${cfg.rules.map((r) => `${r.match} → ${r.workspace}`).join("; ")}`);
        return;
      }
      let msg = "";
      if (["assign", "unassign", "show", "hide", "always-show", "fold"].includes(sub)) {
        // these need the project key (async), so they resolve it before patching
        const p = await resolveProject(pos[1]);
        const key = await projectKey(p, true);
        const saved = await patchWorkspaces(c, (cfg) => {
          if (sub === "assign") {
            const w = resolveWs(cfg, pos[2]);
            placeProject(cfg, key, p.workspaceRoot, [w.id], isScratch(p));
            msg = `${p.title} → workspace ${w.name} (only)`;
          } else if (sub === "show" || sub === "hide") {
            const w = resolveWs(cfg, pos[2]);
            const cur = workspacesOf(cfg, key, p.workspaceRoot, isScratch(p));
            placeProject(
              cfg,
              key,
              p.workspaceRoot,
              sub === "show" ? [...cur, w.id] : cur.filter((id) => id !== w.id),
              isScratch(p),
            );
            msg = `${p.title} shows in: ${workspacesOf(cfg, key, p.workspaceRoot, isScratch(p))
              .map((id) => cfg.workspaces.find((x) => x.id === id)?.name ?? id)
              .join(", ")}`;
          } else if (sub === "unassign") {
            delete cfg.assignments[key];
            if (cfg.placements) delete cfg.placements[key];
            msg = `${p.title}: assignment removed (rules/default apply)`;
          } else {
            // "Quiet projects", per workspace: quiet = moved there by hand (stays), active = never folds, auto = by itself.
            // `always-show <P> [W]` is `fold <P> active [W]`.
            const mode = sub === "always-show" ? "active" : pos[2];
            const wsRef = sub === "always-show" ? pos[2] : pos[3];
            if (!["quiet", "active", "auto"].includes(mode))
              die("usage: t3ctl ws fold <P> quiet|active|auto [<W>]");
            const shown = workspacesOf(cfg, key, p.workspaceRoot, isScratch(p));
            if (!wsRef && shown.length > 1)
              die(
                `${p.title} shows in several workspaces (${shown.map((id) => cfg.workspaces.find((x) => x.id === id)?.name ?? id).join(", ")}); name one: t3ctl ws ${sub} <P> ${sub === "fold" ? `${mode} ` : ""}<W>`,
              );
            const w = wsRef ? resolveWs(cfg, wsRef) : cfg.workspaces.find((x) => x.id === shown[0]);
            if (!w) die("no workspace");
            const inWs = { ...cfg.workspaceFold?.[w.id] };
            delete inWs[key];
            if (mode !== "auto") inWs[key] = mode;
            cfg.workspaceFold = { ...cfg.workspaceFold, [w.id]: inWs };
            if (!Object.keys(inWs).length) delete cfg.workspaceFold[w.id];
            // The global lists before sidebar.23 are no longer read; drop the project from them.
            cfg.alwaysShow = (cfg.alwaysShow ?? []).filter((k) => k !== key);
            cfg.alwaysQuiet = (cfg.alwaysQuiet ?? []).filter((k) => k !== key);
            msg = {
              quiet: `${p.title} moved to quiet projects in ${w.name} (stays there until moved back)`,
              active: `${p.title} never folds into quiet projects in ${w.name}`,
              auto: `${p.title} folds into quiet projects by itself in ${w.name}`,
            }[mode];
          }
          return cfg;
        });
        if (sub === "unassign" && saved.assignments[key] !== undefined) {
          // Servers before sidebar.17 deep-merge the patch and keep the key; point it where
          // rules/default would put the project instead (same result in the sidebar).
          await patchWorkspaces(c, (cfg) => {
            const rest = { ...cfg, assignments: { ...cfg.assignments } };
            delete rest.assignments[key];
            const target = workspaceOf(rest, key, p.workspaceRoot);
            if (target) cfg.assignments[key] = target;
            msg = `${p.title}: back to ${target ?? "no workspace"} (rules/default)`;
            return cfg;
          });
        }
        return console.log(msg);
      }
      await patchWorkspaces(c, (cfg) => {
        if (sub === "add") {
          const name = pos.slice(1).join(" ");
          if (!name) die('usage: t3ctl ws add "Name" [--icon XY] [--color #hex]');
          const id = wsId(name, new Set(cfg.workspaces.map((w) => w.id)));
          const used = new Set(cfg.workspaces.map((w) => w.color));
          cfg.workspaces.push({
            id,
            name,
            color: opt.color || WS_COLORS.find((x) => !used.has(x)) || WS_COLORS[0],
            ...(opt.icon ? { icon: String(opt.icon) } : {}),
          });
          msg = `added workspace ${name} (${id})`;
        } else if (sub === "set" || sub === "rename") {
          const w = resolveWs(cfg, pos[1]);
          if (sub === "rename")
            w.name = pos.slice(2).join(" ") || die('usage: t3ctl ws rename <ws> "New name"');
          if (opt.name) w.name = String(opt.name);
          if (opt.color) w.color = String(opt.color);
          if (opt.icon === "none") delete w.icon;
          else if (opt.icon) w.icon = String(opt.icon);
          msg = `updated workspace ${w.name}`;
        } else if (sub === "rm" || sub === "remove" || sub === "delete") {
          const w = resolveWs(cfg, pos[1]);
          const def = cfg.workspaces.some((x) => x.id === cfg.defaultWorkspace)
            ? cfg.defaultWorkspace
            : cfg.workspaces[0]?.id;
          if (def === w.id)
            die(
              "the default workspace cannot be removed (make another one default first: t3ctl ws default <ws>)",
            );
          if (!opt.yes)
            die(
              `removes workspace ${w.name}; its projects fall back to the default (threads untouched). Re-run with --yes`,
            );
          cfg.workspaces = cfg.workspaces.filter((x) => x.id !== w.id);
          cfg.assignments = Object.fromEntries(
            Object.entries(cfg.assignments).filter(([, v]) => v !== w.id),
          );
          if (cfg.placements) {
            cfg.placements = Object.fromEntries(
              Object.entries(cfg.placements)
                .map(([k, ids]) => [k, ids.filter((id) => id !== w.id)])
                .filter(([, ids]) => ids.length),
            );
            for (const [k, ids] of Object.entries(cfg.placements)) cfg.assignments[k] = ids[0];
          }
          if (cfg.workspaceProjectOrder) delete cfg.workspaceProjectOrder[w.id];
          if (cfg.workspaceFold) delete cfg.workspaceFold[w.id];
          cfg.rules = cfg.rules.filter((r) => r.workspace !== w.id);
          cfg.defaultWorkspace = def;
          msg = `removed workspace ${w.name}`;
        } else if (sub === "default") {
          cfg.defaultWorkspace = resolveWs(cfg, pos[1]).id;
          msg = `default workspace: ${cfg.defaultWorkspace}`;
        } else if (sub === "move") {
          const w = resolveWs(cfg, pos[1]);
          const to = Math.max(0, Math.min(cfg.workspaces.length - 1, Number(pos[2]) - 1));
          cfg.workspaces = cfg.workspaces.filter((x) => x.id !== w.id);
          cfg.workspaces.splice(to, 0, w);
          msg = `moved ${w.name} to position ${to + 1}`;
        } else if (sub === "rule") {
          const [, op, glob, target] = pos;
          if (op === "add") {
            if (!glob || !target) die('usage: t3ctl ws rule add "<glob over project path>" <ws>');
            cfg.rules.push({ match: glob, workspace: resolveWs(cfg, target).id });
            msg = `rule ${glob} → ${target}`;
          } else if (op === "rm") {
            const before = cfg.rules.length;
            cfg.rules = cfg.rules.filter((r) => r.match !== glob);
            msg = `removed ${before - cfg.rules.length} rule(s)`;
          } else die("usage: t3ctl ws rule add|rm ...");
        } else if (sub === "quiet") {
          cfg.quietAfterDays = Number(pos[1]) || die("usage: t3ctl ws quiet <days>");
          msg = `quiet after ${cfg.quietAfterDays} days`;
        } else
          die(
            `unknown ws subcommand "${sub}" (list | add | rename | set | rm | default | move | assign | show | hide | unassign | rule | quiet)`,
          );
        return cfg;
      });
      console.log(msg);
    });
  },

  async scan(pos, opt) {
    const r = await withWs((c) => c.rpc("agentSessions.scan", {}));
    if (opt.json) return json(r);
    const f = (pos[0] || "").toLowerCase();
    for (const x of r.candidates ?? r.directories ?? []) {
      if (f && !JSON.stringify(x).toLowerCase().includes(f)) continue;
      const n = x.threadCount ?? x.sessionCount ?? "";
      console.log(
        `${x.alreadyImported ? "imported " : "         "} ${String(n).padStart(4)}  ${(x.sources || []).join(",").padEnd(18)} ${x.path}${x.lastActiveAt ? `  (${ago(x.lastActiveAt)})` : ""}`,
      );
    }
  },

  async import(pos, opt) {
    if (!pos[0]) die("usage: t3ctl import <project|path> [--add] [--title T]");
    let p;
    const projects = await listProjects();
    try {
      p = await resolveProject(pos[0], projects);
    } catch (e) {
      if (!opt.add)
        throw new Fail(`${e.message}\n(add --add to register ${pos[0]} as a project first)`);
      p = await (
        await mcp()
      ).call("t3_project_create", {
        title: opt.title || basename(expandHome(pos[0])),
        workspaceRoot: expandHome(pos[0]),
      });
    }
    const r = await withWs((c) =>
      c.rpc("agentSessions.import", { projectId: p.id, expectedWorkspaceRoot: p.workspaceRoot }),
    );
    if (opt.json) return json(r);
    console.log(
      `import into ${p.title}: ${r.importedCount} imported, ${r.skippedCount} skipped (only recent sessions are importable)`,
    );
  },

  async settings(pos, opt) {
    await withWs(async (c) => {
      if (!pos[0] || pos[0] === "get") {
        const s = await getSettings(c);
        const v = pos[1] ? pos[1].split(".").reduce((o, k) => o?.[k], s) : s;
        return json(v);
      }
      if (pos[0] === "set") {
        const patch = readJsonArg(pos[1]);
        const s = await c.rpc("server.updateSettings", { patch });
        console.log(`updated: ${Object.keys(patch).join(", ")}`);
        if (opt.json) json(s);
        return;
      }
      die("usage: t3ctl settings [get [dot.path]] | set '{\"key\": value}'");
    });
  },

  async server(pos, opt) {
    const sub = pos[0] || "status";
    if (sub === "status") {
      const r = spawnSync("systemctl", ["--user", "status", UNIT, "--no-pager", "-n", "0"], {
        encoding: "utf8",
      });
      console.log(r.stdout.trim());
      try {
        const i = serverInfo();
        console.log(`runtime: ${i.origin} pid ${i.pid} started ${i.startedAt}`);
      } catch (e) {
        console.log(e.message);
      }
      return;
    }
    if (sub === "logs") {
      const f = join(HOME, "serve.log");
      console.log(execFileSync("tail", ["-n", String(opt.n || 80), f], { encoding: "utf8" }));
      return;
    }
    if (sub === "versions") {
      const dir = join(HOME, "runtime", "versions");
      const unit = execFileSync("systemctl", ["--user", "cat", UNIT], { encoding: "utf8" });
      const cur = /versions\/([^/]+)\/t3/.exec(unit)?.[1];
      for (const v of readdirSync(dir).sort()) console.log(`${v === cur ? "* " : "  "}${v}`);
      return;
    }
    if (sub === "install") {
      // Downloads a fork build's server runtime (CI artifact cli-linux-x64) next to the others.
      // Does not restart anything; switch with `server use <version> --yes`.
      const repo = process.env.T3CTL_RELEASE_REPO || "Gvidon-Solutions/t3code-sidebar";
      const want = String(pos[1] || "latest");
      const runs = JSON.parse(
        execFileSync(
          "gh",
          [
            "run",
            "list",
            "--repo",
            repo,
            "--workflow",
            "sidebar-desktop.yml",
            "--limit",
            "40",
            "--json",
            "databaseId,number,conclusion,headSha,displayTitle",
          ],
          { encoding: "utf8" },
        ),
      );
      const n = /(\d+)$/.exec(want)?.[1];
      const run =
        want === "latest"
          ? runs.find((r) => r.conclusion === "success")
          : runs.find((r) => String(r.number) === n || String(r.databaseId) === want);
      if (!run)
        die(
          `no CI run for "${want}" (recent: ${runs
            .slice(0, 5)
            .map((r) => `#${r.number} ${r.conclusion}`)
            .join(", ")})`,
        );
      if (run.conclusion !== "success") die(`CI run #${run.number} ended "${run.conclusion}"`);
      const tmp = join(HOME, "caches", `t3ctl-install-${run.number}`);
      execFileSync("rm", ["-rf", tmp]);
      mkdirSync(tmp, { recursive: true });
      console.log(
        `downloading cli-linux-x64 of run #${run.number} (${run.headSha.slice(0, 10)} ${clip(run.displayTitle, 60)})…`,
      );
      execFileSync(
        "gh",
        [
          "run",
          "download",
          String(run.databaseId),
          "--repo",
          repo,
          "-n",
          "cli-linux-x64",
          "-D",
          tmp,
        ],
        { stdio: "inherit" },
      );
      const archive = readdirSync(tmp).find((f) => f.endsWith(".tar.gz"));
      const version = /^t3-(.+)-linux-x64\.tar\.gz$/.exec(archive || "")?.[1];
      if (!version) die(`unexpected artifact contents in ${tmp}`);
      const dest = join(HOME, "runtime", "versions", version);
      if (existsSync(join(dest, "t3"))) {
        console.log(`${version} is already installed (${dest})`);
        return;
      }
      mkdirSync(dest, { recursive: true });
      execFileSync("tar", ["xzf", join(tmp, archive), "-C", dest, "--strip-components=1"]);
      execFileSync("rm", ["-rf", tmp]);
      console.log(
        `installed ${version} → ${dest}\nnot running yet; switch with: t3ctl server use ${version} --yes   (owner's go-ahead first)`,
      );
      return;
    }
    if (sub === "restart" || sub === "use") {
      // Owner rule (2026-10-14): the live server restarts only after the owner said yes.
      const target = sub === "use" ? pos[1] : null;
      if (sub === "use" && !target)
        die("usage: t3ctl server use <version> --yes  (see t3ctl server versions)");
      if (!opt.yes)
        die(
          `${sub === "use" ? `switching the server to ${target} restarts it` : "restarting the server"}: every running T3 thread is cut off, including the agent that runs this command.\nOnly with the owner's explicit go-ahead. Re-run with --yes.`,
        );
      if (target) {
        const bin = join(HOME, "runtime", "versions", target, "t3");
        if (!existsSync(bin))
          die(`no runtime ${bin} (put the release's cli-linux-x64 there first)`);
        const unitPath = execFileSync(
          "systemctl",
          ["--user", "show", "-p", "FragmentPath", "--value", UNIT],
          { encoding: "utf8" },
        ).trim();
        const text = readFileSync(unitPath, "utf8");
        const next = text.replace(/runtime\/versions\/[^/]+\/t3/, `runtime/versions/${target}/t3`);
        if (next === text)
          die(`ExecStart in ${unitPath} already uses ${target} or has an unexpected shape`);
        const backup = `${unitPath}.bak-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
        copyFileSync(unitPath, backup);
        writeFileSync(unitPath, next);
        execFileSync("systemctl", ["--user", "daemon-reload"]);
        console.log(`unit now runs ${target} (backup ${backup})`);
      }
      console.log("restarting in 2s…");
      // Detached, so a caller living inside this server still gets its reply out first.
      const before = existsSync(join(USERDATA, "server-runtime.json"))
        ? JSON.parse(readFileSync(join(USERDATA, "server-runtime.json"), "utf8")).pid
        : null;
      spawnSync(
        "systemd-run",
        [
          "--user",
          "--quiet",
          "--on-active=2",
          "--unit",
          `t3ctl-restart-${Date.now()}`,
          "systemctl",
          "--user",
          "restart",
          UNIT,
        ],
        { stdio: "inherit" },
      );
      // Wait for the new process to answer (a caller inside T3 is cut off here, which is expected).
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const info = JSON.parse(readFileSync(join(USERDATA, "server-runtime.json"), "utf8"));
          if (info.pid !== before && (await fetch(info.origin)).ok) {
            console.log(`server is back: pid ${info.pid}, ${info.origin}`);
            return;
          }
        } catch {
          /* still starting */
        }
      }
      die(`server did not come back within 120s; check: t3ctl server status / t3ctl server logs`);
    }
    die(
      "usage: t3ctl server status | logs [--n 80] | versions | install <N|latest> | restart --yes | use <version> --yes",
    );
  },

  async tools(pos, opt) {
    const tools = await (await mcp()).tools();
    if (opt.json) return json(tools);
    const f = (pos[0] || "").toLowerCase();
    for (const t of tools)
      if (!f || t.name.includes(f) || (t.description || "").toLowerCase().includes(f))
        console.log(`${t.name.padEnd(34)} ${clip(t.description, 120)}`);
  },

  async schema(pos) {
    const t = (await (await mcp()).tools()).find((x) => x.name === pos[0]);
    if (!t) die(`no MCP tool "${pos[0]}" (t3ctl tools)`);
    json({ name: t.name, description: t.description, inputSchema: t.inputSchema });
  },

  async tool(pos) {
    if (!pos[0]) die("usage: t3ctl tool <name> ['{json}' | @file.json | -]");
    const res = await (await mcp()).callRaw(pos[0], readJsonArg(pos[1]));
    if (res.isError) {
      console.error((res.content || []).map((c) => c.text).join("\n"));
      process.exitCode = 1;
      return;
    }
    json(res.structuredContent ?? res.content);
  },

  async rpc(pos, opt) {
    if (!pos[0])
      die(
        "usage: t3ctl rpc <method> ['{json}' | @file | -] [--first]   e.g. t3ctl rpc server.getConfig",
      );
    const r = await withWs((c) =>
      c.rpc(pos[0], readJsonArg(pos[1]), { firstChunk: Boolean(opt.first) }),
    );
    json(r);
  },

  async dispatch(pos) {
    const cmd = readJsonArg(pos[0]);
    if (!cmd.type)
      die('usage: t3ctl dispatch \'{"type":"thread.pin","threadId":"…"}\'  (commandId is added)');
    json(await withWs((c) => c.dispatch(cmd)));
  },
};

for (const action of THREAD_ORGANIZE) {
  commands[action] = async (pos, opt) => {
    const t = await resolveThread(pos[0], {
      projectRef: opt.project,
      includeArchived: action === "unarchive",
    });
    const r = await (await mcp()).call("t3_thread_organize", { threadId: t.threadId, action });
    if (opt.json) return json(r);
    console.log(`${action}: "${t.title}"${r?.settlesWhenTurnEnds ? " (when its turn ends)" : ""}`);
  };
}
commands.last = commands.output;
commands.ls = commands.threads;

async function waitThread(threadId, timeoutMs, environmentId) {
  const m = await mcp();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = Math.max(1000, Math.min(110000, deadline - Date.now()));
    const r = await m.call("t3_thread_wait", {
      threadId,
      timeoutMs: left,
      ...(environmentId ? { environmentId } : {}),
    });
    if (!r.timedOut || Date.now() >= deadline) return r;
  }
}

async function waitAndPrint(threadId, opt) {
  // A fresh launch may still be preparing before its run exists; give it a moment.
  await new Promise((r) => setTimeout(r, 1500));
  const timeout = opt.timeout
    ? parseDuration(opt.timeout)
    : typeof opt.wait === "string"
      ? DURATION_ARG.test(opt.wait) && !/[a-z]/.test(opt.wait)
        ? Number(opt.wait) * 1000
        : parseDuration(opt.wait)
      : 30 * 6e4;
  const r = await waitThread(threadId, timeout, opt.environmentId);
  const data = await readAll(threadId, { expand: isLastAnswer, environmentId: opt.environmentId });
  const last = [...data.items]
    .reverse()
    .find((i) => i.type === "assistant_message" || i.type === "proposed_plan");
  if (opt.json) return json({ wait: r, thread: data.thread, output: last?.text ?? null });
  console.log(
    `── ${data.thread.title} · ${r.status}${r.timedOut ? " (timed out, still running)" : ""}`,
  );
  if (last) console.log(last.text);
}

async function pendingRequest(action, input) {
  const m = await mcp();
  const tools = await m.tools();
  return tools.some((t) => t.name === "t3_pending_request")
    ? m.call("t3_pending_request", { action, ...input })
    : m.call(`t3_pending_request_${action}`, input);
}

async function pendingRequests(threadId) {
  const out = [];
  // permission requests: only visible as waiting approval items in the activity timeline
  const data = await readAll(threadId, { view: "activity", maxCharsPerItem: 4000, expand: false });
  for (const it of data.items) {
    if (it.type !== "approval_request" || !["waiting", "pending", "requested"].includes(it.status))
      continue;
    out.push({
      kind: "approval",
      requestId: decodeURIComponent(it.itemId.replace(/^turn-item:runtime-request:/, "")),
      text: it.text ?? it.title ?? "",
    });
  }
  // questions from the agent (user-input requests)
  const list = await pendingRequest("list", { threadId });
  for (const requestId of list.requestIds ?? []) {
    const r = await pendingRequest("read", { threadId, requestId });
    out.push({ kind: "question", requestId, questions: r.questions ?? [] });
  }
  return out;
}

async function uploadAttachments(files) {
  const m = await mcp();
  const out = [];
  for (const f of files) {
    const path = expandHome(f);
    const bytes = readFileSync(path);
    const name = basename(path);
    const ext = name.split(".").pop().toLowerCase();
    const mimeType =
      {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        pdf: "application/pdf",
        md: "text/markdown",
        txt: "text/plain",
        json: "application/json",
      }[ext] || "application/octet-stream";
    const kind = mimeType.startsWith("image/") ? "image" : "file";
    const prep = await m.call("t3_attachment_prepare_upload", {
      upload: { type: kind, name, mimeType, sizeBytes: bytes.length },
    });
    if (process.env.T3CTL_DEBUG) console.error(JSON.stringify(prep));
    const url = new URL(prep.relativeUrl ?? prep.uploadUrl, m.origin);
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": mimeType },
      body: bytes,
    });
    if (!r.ok) die(`upload of ${name} failed: HTTP ${r.status} ${clip(await r.text(), 200)}`);
    out.push(
      prep.attachment ?? {
        type: kind,
        id: prep.attachmentId ?? prep.id,
        name,
        mimeType,
        sizeBytes: bytes.length,
      },
    );
  }
  return out;
}

const HELP = `t3ctl — drive T3 Code (Sidebar) from the terminal. Server: ${HOME}

READ
  projects | project <P>                   list projects / one project's full settings
  threads [--project P] [--status running,failed] [--match w] [--settled] [--snoozed]
          [--archived] [--subagents] [--limit N]           newest first (alias: ls)
  status [--project P] [--hours 24]       what needs you / is working / failed / done
  inbox [--all|--closed|--dismissed]      agent inbox issues (● unread, ⏳ needs owner)
  inbox show <I>                          one issue with its history
  show <T> [--messages N] [--full] [--activity]          thread state + timeline
  output <T>                              full text of the last agent answer (alias: last)
  search "words" [--project P]            search thread titles and content here
  find "words" [--all | --on <M>]         search every machine; machine tags in the output
  threads --all | status --all            one overview across every linked machine
  open <T> [--on <M>]                     show a thread everywhere it is open; prints web + t3-thread links
  open-file <path> [--on <M>] [--line N]  open a file on any machine (t3-file link)
  cat <path> [--on <M>]                   print a file from any machine
  wait <T> [--timeout 30m]                block until the current run finishes
  requests <T>                            pending approvals / questions
  models [agent]                          harnesses (provider instances), models, options
  env | doctor                            server identity | health check after updates
  machines [--json] [--probe]             every known machine: tag, label, id, version, links, replicas
  mesh status [--json]                    links, layout revision, replicas
  mesh link <M> [--url URL] [--ssh DEST]  link a machine (full access; pairing code minted over ssh)
  mesh unlink <M> --yes                   forget a link here (the other machine stays)

THREADS
  self                                  current thread identity (thread-scoped MCP environment)
  new [--project P | --scratch] [opts] "message"   start a thread (no project = scratch)
      --agent claude|codex|deepseek|1017|<instance> (default claude, Opus 5.5)  --model M (aliases: opus sonnet fable haiku luna astra sol deepseek 1017)
      --effort low|medium|high|xhigh|max  --fast  --opt key=value (any model option)
      --mode ${RUNTIME_MODES.join("|")} (default ${DEFAULTS.mode})  --plan  --title T
      --worktree BRANCH|auto [--base REF] [--from-origin]  new git worktree for the thread
      --cwd PATH [--branch B]             run in an existing worktree of the project
      --on <M>                            run on another machine (places a replica first, then launches)
      --attach FILE (repeatable)  --file MSG.txt | -  --wait [dur|--timeout 20m]  print the answer
  send <T> "message" [--queue|--steer|--restart] [--attach F] [--wait]
  stop <T> [--reason R]                   interrupt the running turn
  approve <T> [accept|acceptForSession|acceptAlways|decline|cancel] [--request ID]
  answer <T> ["text" | --answers '{json}'] [--request ID]   answer an agent's question
  fork <T> [--title T] [--message M] [--agent/--model …] [--run ID | --checkpoint ID]
  rename <T> "title" | rename <T> --auto  (regenerate)
  pin | unpin | settle | unsettle | archive | unarchive | unread <T>
  snooze <T> [--for 2h | --until ISO] | unsnooze <T>
  set-model <T> --agent A [--model M] [--effort E]
  set-mode <T> ${RUNTIME_MODES.join("|")}|plan|default
  delete <T> --yes                        permanent (prefer archive)
  bulk <archive|unarchive|settle|unsettle|pin|unpin|delete> [--project P] [--match w]
       [--status completed,failed] [--older-than 7d] [--archived] [--yes]   dry run without --yes
  worktrees <T> [--query q] [--remote]    branches and their checkouts
  queue <T>                               queued messages (edit/cancel: t3ctl tool t3_queue_*)

INBOX (issues agents raise for the owner; <I> = issue id or prefix)
  inbox post <action|attention|info> "Title" --body MD [--key DEDUPE] [--project P] [--waiting]
  inbox comment <I> "text" [--waiting|--not-waiting]    as an agent: progress, result, question
  inbox update <I> [--severity S] [--title T] [--body MD] [--thread T] [--waiting|--not-waiting]
  inbox done <I> "resolution"             agent closes after verifying the fix
  inbox reply <I> "text"                  as the owner; delivered to the responsible thread
  inbox dismiss <I> "reason" | inbox reopen <I>   owner: close as not relevant / undo

PROJECTS
  project-add <path> [--title T] [--mkdir]   register a folder
  project-new "title"                     T3 creates a fresh git repo for it
  project-clone <url|owner/name> [--dest PATH | --dir PARENT]   clone and register
  project-rename <P> "title"
  project-set <P> [--agent/--model/--effort] [--root PATH] [--auto-pull true] [--env-mode local|worktree] [--emoji 🚀] [--json '{…}']
  project-remove <P> --yes [--force]      remove from T3 (files stay); --force also deletes its threads

AGENT INSTRUCTIONS
  agents sync [--to all|machine,…] [--home /isolated/home] [--apply]   diff by default; backup and verify on apply
  agents status [--to all|machine,…] [--home /isolated/home]           per-machine harness file drift

MESH (M = environment id/prefix, label, tag, ssh alias, or a Russian name like «гора»)
  place <P> --on <M> [--primary] [--source <M2>] [--path PATH] [--wait [dur]]
                                          add a representation (replica by default); --wait for watching
  unplace <P> --on <M> --yes              remove a representation (files and the project stay)
  replicas [--json]                       every representation, live state, conflicts
  replica retry <P> --on <M>              recreate/resume a replica session
  layout get [--json]                     the shared layout (legacy settings when the server is old)
  layout merge --from <M[,M]> [--dry-run | --apply]   migrate legacy layouts; backups first

SIDEBAR WORKSPACES (tiles)
  ws [list]                               workspaces and their projects
  ws add "Name" [--icon XY] [--color #hex]
  ws rename <W> "Name" | ws set <W> [--name N] [--icon XY|none] [--color #hex]
  ws assign <P> <W> | ws unassign <P>     put a project into one workspace (only there) / back to rules
  ws show <P> <W> | ws hide <P> <W>       also show a project in a workspace / stop (never the last)
  ws default <W> | ws move <W> <position> | ws rm <W> --yes
  ws rule add "<glob>" <W> | ws rule rm "<glob>" | ws quiet <days> | ws fold <P> quiet|active|auto [W] (W needed when P shows in several)

SESSIONS, SETTINGS, SERVER
  scan [filter] | import <P|path> [--add --title T]    import Codex/Claude sessions from disk
  settings [get [dot.path]] | settings set '{"key": value}'
  server status | logs [--n 80] | versions
  server install <N|latest>               download fork build sidebar.N's server runtime (no restart)
  server restart --yes | server use <version> --yes    ONLY with the owner's explicit go-ahead
  login                                   re-issue the MCP client token (automatic otherwise)

ANYTHING ELSE
  tools [filter] | schema <tool> | tool <name> '{json}'     any T3 MCP tool
  rpc <method> '{json}' [--first]                          any WebSocket RPC method the UI uses
  dispatch '{"type":"thread.…", …}'                        any orchestration command

  <T> = thread id, id prefix, or words from its title/project. <P> = project name, id prefix or path.
  <W> = workspace id or name. JSON args accept '{…}', @file.json or - (stdin). --json prints raw data.`;

// Importable for `node --test` (scripts/t3ctl.unit.test.mjs); only run when invoked directly.
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
const isMain = invokedPath !== "" && import.meta.url === pathToFileURL(invokedPath).href;
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  if (!commands[cmd]) {
    console.error(`t3ctl: unknown command "${cmd}"\n\n${HELP}`);
    process.exit(2);
  }
  const { pos, opt } = parseArgs(rest);
  Promise.resolve()
    .then(() => commands[cmd](pos, opt))
    // Exit only after stdout is drained: process.exit() drops whatever is still
    // buffered for a pipe, which cut JSON output at 64 KiB for callers like vtb-ops.
    .then(
      () => exitAfterFlush(process.exitCode ?? 0),
      (e) => {
        console.error(`t3ctl: ${e instanceof Fail ? e.message : e.stack || e.message}`);
        exitAfterFlush(1);
      },
    );
}

function exitAfterFlush(code) {
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}
