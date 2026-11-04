import { MeshConfigDocument } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { parse } from "yaml";

export const defaults = (): MeshConfigDocument => ({ schema: 1, machines: {} });
const decodeConfig = Schema.decodeUnknownSync(MeshConfigDocument, { errors: "all" });
export const parseConfig = (input: unknown): MeshConfigDocument =>
  decodeConfig(typeof input === "string" ? parse(input) : input);
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
  return name === undefined ? undefined : { name, ...machineByName(config, name) };
};
export const modelAlias = (config: MeshConfigDocument, name: string) =>
  config.agents?.aliases && Object.hasOwn(config.agents.aliases, name)
    ? config.agents.aliases[name]
    : undefined;

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
  return errors;
};
