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
  for (const workspace of [...before.workspaces]
    .sort((a, b) => a.id.localeCompare(b.id))
    .reverse()) {
    const entry = doc[keys.workspace(workspace.id)];
    if (entry && !entry.h.startsWith("0000000000000."))
      existing.set(workspace.name.trim().toLowerCase(), workspace.id);
  }
  const normalize = (source: SidebarWorkspacesConfig): SidebarWorkspacesConfig => {
    const ids = new Map(
      source.workspaces.map((w) => [w.id, existing.get(w.name.trim().toLowerCase()) ?? w.id]),
    );
    const remap = (id: string) => ids.get(id) ?? id;
    const workspaceProjectOrder: Record<string, string[]> = {};
    for (const [id, order] of Object.entries(source.workspaceProjectOrder))
      workspaceProjectOrder[remap(id)] = [
        ...new Set([...(workspaceProjectOrder[remap(id)] ?? []), ...order]),
      ];
    const workspaceFold: Record<string, Record<string, "quiet" | "active">> = {};
    for (const [id, fold] of Object.entries(source.workspaceFold))
      workspaceFold[remap(id)] = { ...workspaceFold[remap(id)], ...fold };
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
      workspaceProjectOrder,
      workspaceFold,
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
        ...before,
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
