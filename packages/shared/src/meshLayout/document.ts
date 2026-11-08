import type { Hlc } from "./hlc.ts";
export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };
export type MeshLayoutEntry = { readonly v: Json | null; readonly h: Hlc };
export type MeshLayoutDocument = Record<string, MeshLayoutEntry>;
const part = encodeURIComponent;
export const keys = {
  author: (hlc: string, environmentId: string) => `author/${part(hlc)}/${part(environmentId)}`,
  projectTitle: (id: string) => `projTitle/${part(id)}`,
  workspace: (id: string) => `ws/${part(id)}`,
  defaultWorkspace: "ws.default",
  quietAfterDays: "ws.quietAfterDays",
  rule: (id: string) => `rule/${part(id)}`,
  place: (project: string, workspace: string) => `place/${part(project)}/${part(workspace)}`,
  order: (project: string) => `order/${part(project)}`,
  fold: (workspace: string, project: string) => `fold/${part(workspace)}/${part(project)}`,
  project: (key: string) => `proj/${part(key)}`,
  alias: (key: string) => `alias/${part(key)}`,
  representation: (logical: string, env: string) => `rep/${part(logical)}/${part(env)}`,
  representationStatus: (logical: string, env: string) => `repstatus/${part(logical)}/${part(env)}`,
  machineClaim: (environmentId: string) => `mesh.machineClaim/${part(environmentId)}`,
  machineBinding: (name: string) => `mesh.machineBinding/${part(name)}`,
  machine: (env: string) => `machine/${part(env)}`,
  // Empty orders override fallback order; membership and ordering are independent in legacy configs.
  workspaceOrder: (id: string) => `workspaceOrder/${part(id)}`,
  empty: (field: string, id: string) => `empty/${part(field)}/${part(id)}`,
  legacy: (field: string) => `legacy/${part(field)}`,
};
export function decodeLayoutKey(key: string): string[] | null {
  try {
    const parts = key.split("/").map(decodeURIComponent);
    return parts.every((part) => part.length > 0) && parts.map(encodeURIComponent).join("/") === key
      ? parts
      : null;
  } catch {
    return null;
  }
}
export function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function merge(a: MeshLayoutDocument, b: MeshLayoutDocument): MeshLayoutDocument {
  const result = { ...a };
  for (const [key, entry] of Object.entries(b)) {
    const old = Object.hasOwn(result, key) ? result[key] : undefined;
    // Equal clocks can occur during repeated imports; a total value order preserves CRDT laws.
    if (!old || entry.h > old.h || (entry.h === old.h && canonical(entry.v) > canonical(old.v))) {
      Object.defineProperty(result, key, {
        value: entry,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return result;
}
