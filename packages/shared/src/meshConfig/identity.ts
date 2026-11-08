import { keys, decodeLayoutKey } from "../meshLayout/document.ts";
import { compare } from "../meshLayout/hlc.ts";
import type { MeshConfigDocument } from "@t3tools/contracts";
import type { Json, MeshLayoutDocument } from "../meshLayout/document.ts";
import { bindingsFromLayout, configFromLayout } from "./index.ts";

const machineSlug = (title: string) =>
  title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "machine";

// Claims are keyed by environment, so independent joins cannot erase each other.
export function repairMachineIdentity(document: MeshLayoutDocument, doc: MeshConfigDocument) {
  const bindings = bindingsFromLayout(document);
  const claims = new Map<
    string,
    { name: string; machine: MeshConfigDocument["machines"][string] }
  >();
  for (const [key, entry] of Object.entries(document)) {
    if (
      !key.startsWith("mesh.machineClaim/") ||
      !decodeLayoutKey(key) ||
      !entry.v ||
      typeof entry.v !== "object" ||
      Array.isArray(entry.v)
    )
      continue;
    const value = entry.v as Record<string, Json>;
    if (
      typeof value.name === "string" &&
      value.machine &&
      typeof value.machine === "object" &&
      !Array.isArray(value.machine)
    )
      claims.set(decodeURIComponent(key.slice("mesh.machineClaim/".length)), {
        name: value.name,
        machine: value.machine as MeshConfigDocument["machines"][string],
      });
  }
  for (const [name, id] of Object.entries(bindings)) {
    if (claims.has(id)) continue;
    const historical = Object.entries(document)
      .filter(([key]) => key.startsWith("mesh.configHistory/"))
      .sort(([, a], [, b]) => compare(b.h, a.h))
      .flatMap(([, entry]) => {
        const value = entry.v;
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const revision = value as Record<string, Json>;
        const config = revision.doc;
        if (!config || typeof config !== "object" || Array.isArray(config)) return [];
        const machines = (config as Record<string, Json>).machines;
        if (!machines || typeof machines !== "object" || Array.isArray(machines)) return [];
        const machine = (machines as Record<string, Json>)[name];
        return machine && typeof machine === "object" && !Array.isArray(machine)
          ? [machine as MeshConfigDocument["machines"][string]]
          : [];
      })[0];
    claims.set(id, { name, machine: doc.machines[name] ?? historical ?? { title: name } });
  }
  for (const [key, entry] of Object.entries(document)) {
    if (
      !key.startsWith("machine/") ||
      !decodeLayoutKey(key) ||
      !entry.v ||
      typeof entry.v !== "object" ||
      Array.isArray(entry.v)
    )
      continue;
    const id = decodeURIComponent(key.slice(8));
    if (claims.has(id) || document[keys.machineClaim(id)]?.v === null) continue;
    const facts = entry.v as Record<string, Json>;
    if (typeof facts.title !== "string" && typeof facts.label !== "string") continue;
    const title =
      typeof facts.title === "string"
        ? facts.title
        : typeof facts.label === "string"
          ? facts.label
          : "machine";
    claims.set(id, { name: machineSlug(title), machine: { title } });
  }
  const desired: Record<string, string> = {};
  const machines = { ...doc.machines };
  const updates: Record<string, Json> = {};
  for (const name of Object.keys(bindings)) delete machines[name];
  const reserved = new Set([...claims.values()].map((claim) => claim.name));
  for (const [id, claim] of [...claims].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let name = claim.name;
    for (let n = 2; desired[name] !== undefined; n++) {
      name = `${claim.name}-${n}`;
      while (reserved.has(name)) name = `${claim.name}-${++n}`;
    }
    desired[name] = id;
    const previousName = Object.keys(bindings).find((bound) => bindings[bound] === id);
    machines[name] = document[`mesh.bootstrapOwner/${name}`]?.v
      ? (doc.machines[name] ?? claim.machine)
      : ((previousName
          ? doc.machines[previousName]
          : !bindings[name]
            ? doc.machines[name]
            : undefined) ?? claim.machine);
    const key = keys.machineClaim(id);
    if (!document[key]) updates[key] = claim as unknown as Json;
  }
  for (const name of new Set([...Object.keys(bindings), ...Object.keys(desired)]))
    if (bindings[name] !== desired[name])
      updates[keys.machineBinding(name)] = desired[name] ?? null;
  const next = { ...doc, machines };
  return {
    docChanged: JSON.stringify(next) !== JSON.stringify(doc),
    doc: next,
    updates,
    changed: Object.keys(updates).length > 0 || JSON.stringify(next) !== JSON.stringify(doc),
  };
}

export function renameMachineBindings(
  document: MeshLayoutDocument,
  before: MeshConfigDocument | undefined,
  after: MeshConfigDocument,
): Record<string, Json> {
  if (!before) return {};
  const removed = Object.keys(before.machines).filter((name) => !after.machines[name]);
  const added = Object.keys(after.machines).filter((name) => !before.machines[name]);
  const bindings = bindingsFromLayout(document);
  const updates: Record<string, Json> = {};
  for (const old of removed) {
    const matches = added.filter(
      (name) => JSON.stringify(before.machines[old]) === JSON.stringify(after.machines[name]),
    );
    if (matches.length !== 1 || !bindings[old]) continue;
    const name = matches[0]!;
    if (
      removed.filter(
        (key) => JSON.stringify(before.machines[key]) === JSON.stringify(after.machines[name]),
      ).length !== 1
    )
      continue;
    if (bindings[name] && bindings[name] !== bindings[old]) continue;
    updates[keys.machineBinding(old)] = null;
    updates[keys.machineBinding(name)] = bindings[old]!;
    updates[keys.machineClaim(bindings[old]!)] = {
      name,
      machine: after.machines[name]!,
    } as Json;
  }
  for (const old of removed) {
    const id = bindings[old];
    if (id && updates[keys.machineBinding(old)] === undefined) {
      updates[keys.machineBinding(old)] = null;
      updates[keys.machineClaim(id)] = null;
    }
  }
  return updates;
}

export function localMachineClaim(
  document: MeshLayoutDocument,
  self: { environmentId: string; label: string },
  h: string,
): MeshLayoutDocument {
  const key = keys.machineClaim(self.environmentId);
  if (document[key]) return {};
  const name =
    Object.entries(bindingsFromLayout(document)).find(([, id]) => id === self.environmentId)?.[0] ??
    machineSlug(self.label);
  return {
    [key]: {
      v: {
        name,
        machine: configFromLayout(document)?.machines[name] ?? { title: self.label },
      } as Json,
      h,
    },
  };
}
