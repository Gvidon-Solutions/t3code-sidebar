import { sha256 } from "@noble/hashes/sha2";
import { canonical, keys, type MeshLayoutDocument, type MeshLayoutEntry } from "./document.ts";

const legacy = (key: string) =>
  /^(?:title:|[^:]+:(?:\/|[A-Za-z]:[\\/])|[\w.-]+\.[\w.-]+\/)/.test(key);
export function opaqueProjectId(key: string): string {
  if (!legacy(key)) return key;
  return `lp-${Array.from(sha256(new TextEncoder().encode(key)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// Keep original clocks: a later canonical tombstone must beat a delayed legacy replica entry.
export function migrateLogicalProjectIds(document: MeshLayoutDocument): MeshLayoutDocument {
  const aliases = new Map<string, string>();
  for (const [key, entry] of Object.entries(document))
    if (key.startsWith("alias/") && typeof entry.v === "string")
      aliases.set(decodeURIComponent(key.slice(6)), entry.v);
  const resolve = (key: string) => {
    const visited: string[] = [];
    while (aliases.has(key) && !visited.includes(key)) {
      visited.push(key);
      key = aliases.get(key)!;
    }
    if (visited.includes(key)) key = [...visited, key].sort()[0]!;
    return opaqueProjectId(key);
  };
  const result: MeshLayoutDocument = {};
  const put = (key: string, entry: MeshLayoutEntry) => {
    const old = result[key];
    if (!old || entry.h > old.h || (entry.h === old.h && canonical(entry.v) > canonical(old.v)))
      Object.defineProperty(result, key, {
        value: entry,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  };
  const migrated = new Map<string, MeshLayoutEntry>();
  const project = (id: string, entry: MeshLayoutEntry) => {
    const next = resolve(id);
    if (next !== id && (!migrated.has(id) || migrated.get(id)!.h < entry.h))
      migrated.set(id, entry);
    return next;
  };
  for (const [key, entry] of Object.entries(document)) {
    let target = key;
    let value = entry.v;
    const [family, a = "", b = ""] = key.split("/").map(decodeURIComponent);
    if (family === "proj") {
      const title = key.endsWith(".title");
      const id = project(decodeURIComponent(key.slice(5, title ? -6 : undefined)), entry);
      target = title ? keys.projectTitle(id) : keys.project(id);
    } else if (
      family === "rep" ||
      family === "repstatus" ||
      family === "place" ||
      family === "order"
    ) {
      const id = project(a, entry);
      target =
        family === "rep"
          ? keys.representation(id, b)
          : family === "repstatus"
            ? keys.representationStatus(id, b)
            : family === "place"
              ? keys.place(id, b)
              : keys.order(id);
    } else if (family === "fold") target = keys.fold(a, project(b, entry));
    else if (family === "empty" && (a === "projectMounts" || a === "projectMountStatus"))
      target = keys.empty(a, project(b, entry));
    else if (family === "alias" && typeof value === "string") value = resolve(value);
    else if (
      family === "legacy" &&
      (a === "alwaysShow" || a === "alwaysQuiet") &&
      Array.isArray(value)
    )
      value = value.map((id) => (typeof id === "string" ? project(id, entry) : id));
    if (
      family === "rep" &&
      a !== resolve(a) &&
      legacy(a) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !("syncKey" in value)
    )
      value = { ...value, syncKey: a };
    put(target, value === entry.v ? entry : { ...entry, v: value });
  }
  for (const [id, entry] of migrated) {
    if (legacy(id)) put(keys.alias(id), { h: entry.h, v: resolve(id) });
  }
  return result;
}
