import type { SidebarWorkspacesConfig } from "@t3tools/contracts";
import { diff } from "./diff.ts";
import { merge, type MeshLayoutDocument } from "./document.ts";
import { mergeLegacyConfigs } from "./importLegacy.ts";
import { materialize } from "./materialize.ts";

/** Reconcile legacy names only at adoption; later user edits retain their workspace identity. */
export function adoptLegacy(
  config: SidebarWorkspacesConfig,
  doc: MeshLayoutDocument,
): MeshLayoutDocument {
  const before = materialize(doc);
  const unified = mergeLegacyConfigs(
    [
      { config: before, envId: "document" },
      { config, envId: "legacy" },
    ],
    "0000000000000.00000.import",
  );
  const byName = new Map(unified.workspaces.map((w) => [w.name.trim().toLowerCase(), w.id]));
  const placements: Record<string, string[]> = {};
  for (const source of [before, config]) {
    const remap = new Map(
      source.workspaces.map((w) => [w.id, byName.get(w.name.trim().toLowerCase()) ?? w.id]),
    );
    for (const project of Object.keys({ ...source.assignments, ...source.placements })) {
      const ids = source.placements[project] ?? [source.assignments[project]!];
      placements[project] = [
        ...new Set([...(placements[project] ?? []), ...ids.map((id) => remap.get(id) ?? id)]),
      ].sort();
    }
  }
  return merge(
    doc,
    diff(
      before,
      {
        ...unified,
        placements,
        assignments: Object.fromEntries(
          Object.entries(placements)
            .filter(([, ids]) => ids.length > 0)
            .map(([p, ids]) => [p, ids[0]!]),
        ),
      },
      doc,
      "0000000000000.00001.adoption",
    ),
  );
}
