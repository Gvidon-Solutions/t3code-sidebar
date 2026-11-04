import {
  MachineName,
  LinkPermissions,
  MeshConfigRevision,
  MeshConfigServerStatus,
  MeshLayoutError,
} from "@t3tools/contracts";
import type { MeshLayoutDocument } from "@t3tools/shared/meshLayout";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const entryJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isRevision = Schema.is(MeshConfigRevision);
const isConfigStatus = Schema.is(MeshConfigServerStatus);
const isLinkPermissions = Schema.is(LinkPermissions);
const isMachineName = Schema.is(MachineName);
const keyPattern =
  /^(?:proj\/[^/]+\.title|ws\.(?:default|quietAfterDays)|(?:ws|rule|order|alias|proj|machine|writer|workspaceOrder|legacy)\/[^/]+|(?:place|fold|rep|repstatus|empty|author)\/[^/]+\/[^/]+)$/;
export const validateEntries = Effect.fn("MeshLayout.validateEntries")(function* (
  entries: MeshLayoutDocument,
) {
  const invalid = yield* Effect.try({
    try: () =>
      Object.keys(entries).filter((key) => !key.startsWith("author/")).length > 5000 ||
      Object.keys(entries).length > 10000 ||
      Object.entries(entries).some(([key, entry]) => {
        const isConfig = key === "mesh.config" || /^mesh\.configHistory\/[^/]+$/.test(key);
        const isBinding = key.startsWith("mesh.machineBinding/");
        const isStatus = key.startsWith("mesh.configStatus/");
        const isPolicy = /^mesh\.(?:linkPolicy|configReplica)\/[^/]+\/[^/]+$/.test(key);
        const isLegacyAuthority = key === "mesh.authority";
        if (
          (!keyPattern.test(key) &&
            !isConfig &&
            !isBinding &&
            !isStatus &&
            !isPolicy &&
            !isLegacyAuthority) ||
          !/^\d{13}\.\d{5}\..+$/.test(entry.h)
        )
          return true;
        if (isConfig && entry.v !== null && !isRevision(entry.v)) return true;
        if (
          isPolicy &&
          entry.v !== null &&
          (key.startsWith("mesh.configReplica/")
            ? typeof entry.v !== "boolean"
            : !isLinkPermissions(entry.v))
        )
          return true;
        if (
          isStatus &&
          (!decodeURIComponent(key.slice("mesh.configStatus/".length)) ||
            (entry.v !== null && !isConfigStatus(entry.v)))
        )
          return true;
        if (
          isBinding &&
          (!isMachineName(key.slice("mesh.machineBinding/".length)) ||
            (entry.v !== null && (typeof entry.v !== "string" || !entry.v.trim())))
        )
          return true;
        for (const part of key.split("/")) decodeURIComponent(part);
        return new TextEncoder().encode(entryJson({ [key]: entry })).byteLength > 65536;
      }),
    catch: (cause) =>
      new MeshLayoutError({ reason: "invalid_entries", message: "Invalid mesh entries", cause }),
  });
  if (invalid)
    return yield* new MeshLayoutError({
      reason: "invalid_entries",
      message: "Invalid mesh key, clock, entry size or batch size",
    });
});

export const validateClientEntries = Effect.fn("MeshLayout.validateClientEntries")(function* (
  entries: Readonly<Record<string, unknown>>,
) {
  if (Object.keys(entries).some((key) => /^mesh\.(?:config|machineBinding|linkPolicy)/.test(key)))
    return yield* new MeshLayoutError({
      reason: "invalid_entries",
      message: "Mesh config entries must be changed through meshConfig.apply",
    });
});
