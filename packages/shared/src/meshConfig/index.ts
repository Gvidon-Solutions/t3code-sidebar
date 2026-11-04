import { MeshConfigDocument, MeshConfigRevision } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { parse, stringify } from "yaml";

export const configYaml = (doc: unknown): string => stringify(doc);

export const defaults = (): MeshConfigDocument => ({ schema: 1, machines: {} });
const decodeConfig = Schema.decodeUnknownSync(MeshConfigDocument, { errors: "all" });
const decodeJson = Schema.decodeUnknownSync(Schema.Json);
export const parseConfig = (input: unknown): MeshConfigDocument =>
  decodeConfig(decodeJson(typeof input === "string" ? parse(input) : input));
export const effectiveLinkPermissions = (config: MeshConfigDocument, a: string, b: string) => {
  const override = config.links?.overrides?.find(
    ({ between }) => between.includes(a) && between.includes(b),
  );
  return {
    files: override?.files ?? config.links?.default?.files ?? "projects",
    replicas: override?.replicas ?? config.links?.default?.replicas ?? true,
    threads: override?.threads ?? config.links?.default?.threads ?? true,
  };
};
const glob = (pattern: string, title: string) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((s) =>
        s
          .split("?")
          .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("."),
      )
      .join(".*")}$`,
    "u",
  ).test(title);
const DEFAULT_IGNORES = [
  "/node_modules",
  "/.venv",
  "/dist",
  "/build",
  "/target",
  "/.t3",
  "/.t3-conflicts",
  "node_modules",
] as const;
export const projectPolicy = (config: MeshConfigDocument, title: string) => {
  const overrides = config.projects?.overrides?.filter((p) => glob(p.project, title)) ?? [];
  const policies = [config.projects?.defaults, ...overrides];
  return {
    conflicts: policies.findLast((p) => p?.conflicts !== undefined)?.conflicts ?? "primary-wins",
    replica: policies.findLast((p) => p?.replica !== undefined)?.replica ?? "lite",
    ignore: [
      ...new Set([
        ...DEFAULT_IGNORES,
        ...(config.replicas?.ignore ?? []),
        ...(config.projects?.defaults?.ignore ?? []),
        ...overrides.flatMap((p) => p.ignore ?? []),
      ]),
    ],
  };
};
export const replicaRules = (config: MeshConfigDocument, title: string) =>
  config.replicas?.rules?.filter((rule) => glob(rule.project, title)) ?? [];
export const machineByName = (config: MeshConfigDocument, name: string) =>
  Object.hasOwn(config.machines, name) ? config.machines[name] : undefined;
export const machineByEnvironment = (
  config: MeshConfigDocument,
  bindings: Readonly<Record<string, string>>,
  environmentId: string,
) => {
  const name = Object.keys(bindings).find((n) => bindings[n] === environmentId);
  return name === undefined ? undefined : { ...machineByName(config, name), name };
};
export const modelAlias = (config: MeshConfigDocument, name: string) =>
  config.agents?.aliases && Object.hasOwn(config.agents.aliases, name)
    ? config.agents.aliases[name]
    : undefined;

const peerLabels = (config: MeshConfigDocument, name: string) => {
  const machine = machineByName(config, name);
  if (!machine) return [];
  const extra = Array.isArray(machine.legacyPeerLabels)
    ? machine.legacyPeerLabels.filter((label): label is string => typeof label === "string")
    : [];
  return [
    name,
    machine.title,
    machine.label,
    ...(Array.isArray(machine.aliases)
      ? machine.aliases.filter((alias): alias is string => typeof alias === "string")
      : []),
    ...extra,
  ].filter((label): label is string => typeof label === "string" && label.length > 0);
};

/**
 * The configured machine an incoming peer link belongs to. Peer links carry
 * the label the linking environment signed in with; bindings carry the id.
 * An unknown label falls back to the defaults, never to broader permissions.
 */
export const machineByPeerLabel = (
  config: MeshConfigDocument,
  bindings: Readonly<Record<string, string>>,
  peerLabel: string | undefined,
) => {
  if (peerLabel === undefined) return undefined;
  const compact = peerLabel.replace(/^T3 Code\s*·\s*/u, "").trim();
  const matches = Object.entries(bindings).filter(
    ([name]) =>
      peerLabels(config, name).includes(peerLabel) || peerLabels(config, name).includes(compact),
  );
  return matches.length === 1
    ? {
        name: matches[0]![0],
        environmentId: matches[0]![1],
        machine: machineByName(config, matches[0]![0]),
      }
    : undefined;
};

/** Compare two config documents by path, for a stale apply's rebase hint. */
export const configDiff = (
  before: unknown,
  after: unknown,
  path = "$",
): { path: string; before: unknown; after: unknown }[] => {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isRecord(before) || !isRecord(after))
    return [{ path, before: before ?? null, after: after ?? null }];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
    configDiff(before[key], after[key], `${path}.${key}`),
  );
};

const globsOverlap = (patternA: string, patternB: string) => {
  const a = [...patternA];
  const b = [...patternB];
  const pending: [number, number][] = [[0, 0]];
  const seen = new Set<string>();
  while (pending.length) {
    const [i, j] = pending.pop()!;
    const key = i + ":" + j;
    if (seen.has(key)) continue;
    seen.add(key);
    if (i === a.length && j === b.length) return true;
    if (a[i] === "*") pending.push([i + 1, j]);
    if (b[j] === "*") pending.push([i, j + 1]);
    if (
      i < a.length &&
      j < b.length &&
      (a[i] === b[j] || a[i] === "*" || a[i] === "?" || b[j] === "*" || b[j] === "?")
    )
      pending.push([a[i] === "*" ? i : i + 1, b[j] === "*" ? j : j + 1]);
  }
  return false;
};

export const referenceErrors = (config: MeshConfigDocument) => {
  const errors: { path: string; message: string }[] = [];
  const known = (name: string, path: string) => {
    if (!Object.hasOwn(config.machines, name))
      errors.push({ path, message: `Unknown machine: ${name}` });
  };
  if (config.schema !== 1)
    errors.push({ path: "schema", message: `Unsupported schema: ${config.schema}` });
  for (const [name, machine] of Object.entries(config.machines)) {
    if (
      typeof machine.reach === "object" &&
      "via" in machine.reach &&
      typeof machine.reach.via === "string"
    )
      known(machine.reach.via, `machines.${name}.reach.via`);
    const seen = new Set([name]);
    let reach = machine.reach;
    while (typeof reach === "object" && typeof reach.via === "string") {
      if (seen.has(reach.via)) {
        errors.push({
          path: `machines.${name}.reach.via`,
          message: "Reach route contains a cycle",
        });
        break;
      }
      seen.add(reach.via);
      reach = config.machines[reach.via]?.reach;
    }
  }
  const pairs = new Set<string>();
  config.links?.overrides?.forEach((item, i) => {
    item.between.forEach((name, j) => known(name, `links.overrides.${i}.between.${j}`));
    const pair = [...item.between].sort().join("/");
    if (pairs.has(pair) || item.between[0] === item.between[1])
      errors.push({ path: `links.overrides.${i}.between`, message: "Overlapping link override" });
    pairs.add(pair);
  });
  config.replicas?.rules?.forEach((rule, i) => known(rule.on, `replicas.rules.${i}.on`));
  const overrides = config.projects?.overrides ?? [];
  overrides.forEach((override, i) =>
    overrides.slice(0, i).forEach((before, j) => {
      if (!globsOverlap(before.project, override.project)) return;
      for (const field of ["conflicts", "replica"] as const)
        if (
          before[field] !== undefined &&
          override[field] !== undefined &&
          before[field] !== override[field]
        )
          errors.push({
            path: `projects.overrides.${i}.${field}`,
            message: `Overlapping project override with projects.overrides.${j}`,
          });
    }),
  );
  return errors;
};

const decodeRevision = Schema.decodeUnknownOption(MeshConfigRevision);
export const configFromLayout = (document: Readonly<Record<string, { readonly v: unknown }>>) => {
  const revision = decodeRevision(document["mesh.config"]?.v);
  return revision._tag === "Some" ? revision.value.doc : undefined;
};
export const bindingsFromLayout = (document: Readonly<Record<string, { readonly v: unknown }>>) =>
  Object.fromEntries(
    Object.entries(document).flatMap(([key, entry]) =>
      key.startsWith("mesh.machineBinding/") && typeof entry.v === "string"
        ? [[decodeURIComponent(key.slice(20)), entry.v]]
        : [],
    ),
  );
export const conflictWinner = (
  policy: "primary-wins" | "newest-wins",
  primaryMtime: number,
  replicaMtime: number,
): "alpha" | "beta" => (policy === "newest-wins" && replicaMtime > primaryMtime ? "beta" : "alpha");
