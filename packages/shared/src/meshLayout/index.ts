// T3 Mesh (fork): the shared layout document — a pure LWW-map CRDT used by server and clients.
export * from "./hlc.ts";
export * from "./fractionalIndex.ts";
export { keys, merge, apply, entriesNewerThan, canonical } from "./document.ts";
export type { Json, MeshLayoutEntry, MeshLayoutDocument } from "./document.ts";
export { materialize } from "./materialize.ts";
export { diff, encode } from "./diff.ts";
export * from "./importLegacy.ts";
export { adoptLegacy } from "./adoptLegacy.ts";

export { meshAuthorityOf, conflictWinner } from "./authority.ts";

export { meshMachineLabel } from "./machineNames.ts";
export { threadProjectTarget } from "./threadTarget.ts";
export { opaqueProjectId, migrateLogicalProjectIds } from "./logicalIds.ts";
