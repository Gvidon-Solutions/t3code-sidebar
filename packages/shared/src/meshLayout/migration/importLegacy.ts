import type { SidebarWorkspacesConfig } from "@t3tools/contracts";
import { encode } from "../diff.ts";
import { merge, type MeshLayoutDocument } from "../document.ts";
import { materialize } from "../materialize.ts";
import type { Hlc } from "../hlc.ts";

export function importLegacy(
  config: SidebarWorkspacesConfig,
  envId: string,
  lowHlc: Hlc,
): MeshLayoutDocument {
  const h = `${lowHlc.slice(0, 20)}${envId}`;
  return Object.fromEntries(Object.entries(encode(config)).map(([key, v]) => [key, { v, h }]));
}
export function mergeLegacyConfigs(
  sources: readonly { config: SidebarWorkspacesConfig; envId: string }[],
  lowHlc: Hlc,
): SidebarWorkspacesConfig {
  const winners = new Map<string, string>();
  for (const { config } of sources)
    for (const ws of config.workspaces) {
      const name = ws.name.trim().toLowerCase();
      const previous = winners.get(name);
      if (!previous || ws.id < previous) winners.set(name, ws.id);
    }
  let doc: MeshLayoutDocument = {};
  for (const { config, envId } of sources) {
    const remaps = new Map(
      config.workspaces.map((w) => [w.id, winners.get(w.name.trim().toLowerCase())!]),
    );
    const remap = (id: string) => remaps.get(id) ?? id;
    const workspaceProjectOrder: Record<string, string[]> = {};
    const workspaceFold: Record<string, Record<string, "quiet" | "active">> = {};
    for (const [id, order] of Object.entries(config.workspaceProjectOrder))
      workspaceProjectOrder[remap(id)] = [
        ...new Set([...(workspaceProjectOrder[remap(id)] ?? []), ...order]),
      ];
    for (const [id, fold] of Object.entries(config.workspaceFold))
      workspaceFold[remap(id)] = { ...workspaceFold[remap(id)], ...fold };
    const normalized = {
      ...config,
      workspaces: [
        ...new Map(config.workspaces.map((w) => [remap(w.id), { ...w, id: remap(w.id) }])).values(),
      ],
      assignments: Object.fromEntries(
        Object.entries(config.assignments).map(([p, w]) => [p, remap(w)]),
      ),
      placements: Object.fromEntries(
        Object.entries(config.placements).map(([p, ws]) => [p, [...new Set(ws.map(remap))]]),
      ),
      rules: config.rules.map((r) => ({ ...r, workspace: remap(r.workspace) })),
      defaultWorkspace: config.defaultWorkspace === null ? null : remap(config.defaultWorkspace),
      workspaceProjectOrder,
      workspaceFold,
    };
    doc = merge(doc, importLegacy(normalized, envId, lowHlc));
  }
  return {
    ...materialize(doc),
    alwaysShow: [...new Set(sources.flatMap((s) => s.config.alwaysShow))].sort(),
    alwaysQuiet: [...new Set(sources.flatMap((s) => s.config.alwaysQuiet))].sort(),
  };
}
