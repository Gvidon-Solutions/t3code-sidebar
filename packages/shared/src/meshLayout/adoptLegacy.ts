import type { SidebarWorkspacesConfig } from "@t3tools/contracts";
import { diff } from "./diff.ts";
import { keys, merge, type MeshLayoutDocument } from "./document.ts";
import { mergeLegacyConfigs } from "./importLegacy.ts";
import { materialize } from "./materialize.ts";

/** Reconcile legacy names only at adoption; later user edits retain their workspace identity. */
export function adoptLegacy(
  config: SidebarWorkspacesConfig,
  doc: MeshLayoutDocument,
): MeshLayoutDocument {
  const before = materialize(doc);
  const existing = new Map<string, string>();
  for (const workspace of [...before.workspaces].sort((a, b) => (a.id < b.id ? 1 : -1))) {
    const entry = doc[keys.workspace(workspace.id)];
    if (entry && !entry.h.startsWith("0000000000000."))
      existing.set(workspace.name.trim().toLowerCase(), workspace.id);
  }
  const normalize = (source: SidebarWorkspacesConfig): SidebarWorkspacesConfig => {
    const ids = new Map(
      source.workspaces.map((w) => [w.id, existing.get(w.name.trim().toLowerCase()) ?? w.id]),
    );
    const remap = (id: string) => ids.get(id) ?? id;
    return {
      ...source,
      workspaces: [
        ...new Map(source.workspaces.map((w) => [remap(w.id), { ...w, id: remap(w.id) }])).values(),
      ],
      assignments: Object.fromEntries(
        Object.entries(source.assignments).map(([p, w]) => [p, remap(w)]),
      ),
      placements: Object.fromEntries(
        Object.entries(source.placements).map(([p, ws]) => [p, [...new Set(ws.map(remap))]]),
      ),
      rules: source.rules.map((rule) => ({ ...rule, workspace: remap(rule.workspace) })),
      defaultWorkspace: source.defaultWorkspace === null ? null : remap(source.defaultWorkspace),
      workspaceProjectOrder: Object.fromEntries(
        Object.entries(source.workspaceProjectOrder).map(([w, order]) => [remap(w), order]),
      ),
      workspaceFold: Object.fromEntries(
        Object.entries(source.workspaceFold).map(([w, fold]) => [remap(w), fold]),
      ),
    };
  };
  const unified = mergeLegacyConfigs(
    [
      { config: normalize(before), envId: "document" },
      { config: normalize(config), envId: "legacy" },
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
