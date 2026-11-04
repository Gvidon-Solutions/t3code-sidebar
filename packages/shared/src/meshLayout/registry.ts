import * as Schema from "effect/Schema";
import {
  SidebarWorkspace,
  SidebarWorkspaceRule,
  SidebarMachine,
  SidebarProjectMount,
  SidebarProjectMountStatus,
} from "@t3tools/contracts";
import type { MeshLayoutEntry } from "./document.ts";

const sort = { sort: Schema.String };
const sorted = Schema.Struct(sort);
const configRevision = Schema.Struct({
  revision: Schema.String,
  doc: Schema.Unknown,
  author: Schema.String,
  writtenAt: Schema.String,
});
const family = <S extends Schema.Decoder<unknown>>(schema: S, segments: number) => ({
  segments,
  validate: (value: unknown): string | null => {
    const result = Schema.decodeUnknownExit(schema)(value);
    return result._tag === "Success" ? null : String(result.cause);
  },
});

export const layoutKeyFamilies = {
  ws: family(
    Schema.Struct({
      ...sort,
      name: SidebarWorkspace.fields.name,
      icon: Schema.optionalKey(Schema.String),
      color: Schema.optionalKey(Schema.String),
    }),
    2,
  ),
  rule: family(Schema.Struct({ ...sort, ...SidebarWorkspaceRule.fields }), 2),
  place: family(
    Schema.Struct({
      ...sort,
      placed: Schema.optionalKey(Schema.Boolean),
      ordered: Schema.optionalKey(Schema.Boolean),
      placementIndex: Schema.optionalKey(Schema.Number),
    }),
    3,
  ),
  order: family(sorted, 2),
  fold: family(Schema.Literals(["quiet", "active"]), 3),
  machine: family(SidebarMachine, 2),
  proj: family(Schema.Struct({ title: Schema.String }), 2),
  alias: family(Schema.String, 2),
  rep: family(SidebarProjectMount, 3),
  repstatus: family(SidebarProjectMountStatus, 3),
  writer: family(Schema.Boolean, 2),
  author: family(Schema.Boolean, 3),
  workspaceOrder: family(Schema.Boolean, 2),
  empty: family(Schema.Boolean, 3),
  legacy: family(Schema.Array(Schema.String), 2),
  "ws.default": family(Schema.String, 1),
  "ws.quietAfterDays": family(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })), 1),
  "mesh.config": family(configRevision, 1),
  "mesh.configHistory": family(configRevision, 2),
  "mesh.machineBinding": family(Schema.String, 2),
};

export function validateLayoutEntry(key: string, entry: MeshLayoutEntry): string | null {
  if (!/^\d{13}\.\d{5}\..+$/.test(entry.h)) return "invalid HLC";
  let parts: string[];
  try {
    parts = key.split("/").map(decodeURIComponent);
  } catch {
    return "invalid key encoding";
  }
  if (parts.some((part) => part.length === 0)) return "empty key segment";
  const name = parts[0]!;
  const spec = Object.hasOwn(layoutKeyFamilies, name)
    ? layoutKeyFamilies[name as keyof typeof layoutKeyFamilies]
    : undefined;
  if (spec === undefined) return null;
  if (parts.length !== spec.segments) return "invalid key segment count";
  if (name === "ws" && !parts[1]!.trim()) return "workspace id must not be blank";
  if (entry.v === null) return null;
  if (name === "proj" && key.endsWith(".title"))
    return typeof entry.v === "string" ? null : "project title must be a string";
  return spec.validate(entry.v);
}
