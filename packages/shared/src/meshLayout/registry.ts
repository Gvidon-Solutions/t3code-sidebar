import * as Schema from "effect/Schema";
import {
  SidebarWorkspace,
  SidebarWorkspaceRule,
  SidebarMachine,
  SidebarProjectMount,
  SidebarProjectMountStatus,
  MeshConfigRevision,
  MeshConfigActionStatus,
  MeshUpdateVoteInput,
  MeshConfigServerStatus,
  LinkPermissions,
  MachineName,
} from "@t3tools/contracts";
import type { MeshLayoutEntry } from "./document.ts";
const isMachineName = Schema.is(MachineName);

const sort = { sort: Schema.String };
const sorted = Schema.Struct(sort);

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
  "mesh.updateLease": family(MeshUpdateVoteInput, 1),
  "mesh.updateVote": family(MeshUpdateVoteInput, 2),
  "mesh.updateFailure": family(
    Schema.Struct({ environmentId: Schema.String, reason: Schema.String, target: Schema.String }),
    2,
  ),
  "mesh.bootstrapStatus": family(MeshConfigActionStatus, 4),
  "mesh.bootstrapOwner": family(Schema.String, 2),
  "mesh.bootstrapWake": family(Schema.String, 2),
  "mesh.agentMigration": family(Schema.Boolean, 2),
  "mesh.config": family(MeshConfigRevision, 1),
  "mesh.configHistory": family(MeshConfigRevision, 2),
  "mesh.machineBinding": family(
    Schema.String.check(Schema.makeFilter((value) => value.trim().length > 0)),
    2,
  ),
  "mesh.machineClaim": family(
    Schema.Struct({ name: MachineName, machine: Schema.Record(Schema.String, Schema.Unknown) }),
    2,
  ),
  "mesh.configStatus": family(MeshConfigServerStatus, 2),
  "mesh.configReplica": family(Schema.Boolean, 3),
  "mesh.linkPolicy": family(LinkPermissions, 3),
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
  if (parts.map(encodeURIComponent).join("/") !== key) return "noncanonical key encoding";
  if (parts.length !== spec.segments) return "invalid key segment count";
  if (name === "ws" && !parts[1]!.trim()) return "workspace id must not be blank";
  if (name === "mesh.machineBinding" && !isMachineName(parts[1]!))
    return "machine name must be a slug";
  if (entry.v === null) return null;
  if (name === "proj" && key.endsWith(".title"))
    return typeof entry.v === "string" ? null : "project title must be a string";
  const error = spec.validate(entry.v);
  if (error !== null) return error;
  if (name === "rep" && (entry.v as { environmentId: string }).environmentId !== parts[2])
    return "representation environment does not match key";
  return null;
}
