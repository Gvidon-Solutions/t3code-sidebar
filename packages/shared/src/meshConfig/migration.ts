import * as Schema from "effect/Schema";
import type { MeshConfigDocument, SidebarWorkspacesConfig } from "@t3tools/contracts";
import type { MeshLayoutDocument } from "../meshLayout/document.ts";

const legacyMachine = Schema.decodeUnknownOption(
  Schema.Struct({
    reach: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.Struct({ ssh: Schema.String, identityFile: Schema.optionalKey(Schema.String) }),
      ),
    ),
  }),
);

export function migrateConfig(
  document: MeshLayoutDocument,
  layout: SidebarWorkspacesConfig,
  self: { environmentId: string; label: string },
  peers: readonly { environmentId: string; label: string }[],
  ignores: readonly string[],
) {
  if (Object.hasOwn(document, "mesh.config")) return undefined;
  const bindings: Record<string, string> = {};
  const machines: Record<string, MeshConfigDocument["machines"][string]> = {};
  const environments = [
    ...new Set([
      ...Object.keys(layout.machines),
      self.environmentId,
      ...peers.map((peer) => peer.environmentId),
    ]),
  ].sort();
  for (const environmentId of environments) {
    const machine = layout.machines[environmentId];
    const title =
      machine?.title ??
      machine?.label ??
      (environmentId === self.environmentId
        ? self.label
        : peers.find((peer) => peer.environmentId === environmentId)?.label) ??
      "machine";
    const stem =
      title
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "machine";
    let name = stem;
    for (let n = 2; Object.hasOwn(bindings, name); n++) name = `${stem}-${n}`;
    bindings[name] = environmentId;
    const legacyLabels = [
      ...new Set(
        [
          title,
          machine?.label,
          environmentId === self.environmentId ? self.label : undefined,
          peers.find((peer) => peer.environmentId === environmentId)?.label,
        ].filter((label): label is string => typeof label === "string"),
      ),
    ];
    machines[name] = {
      title,
      ...(machine?.tag ? { label: machine.tag } : {}),
      ...(machine?.color ? { color: machine.color } : {}),
      ...(machine?.aliases ? { aliases: machine.aliases } : {}),
      legacyPeerLabels: legacyLabels.flatMap((label) => [`T3 Code · ${label}`, label]),
    };
  }
  const names = Object.keys(bindings);
  const routes = names.flatMap((from) =>
    Object.entries(
      (() => {
        const id = bindings[from]!;
        const decoded = legacyMachine(
          document[`machine/${encodeURIComponent(id)}`]?.v ?? layout.machines[id],
        );
        return decoded._tag === "Some" ? (decoded.value.reach ?? {}) : {};
      })(),
    ).flatMap(([target, route]) => {
      const to = names.find((name) => bindings[name] === target);
      return to ? [{ from, to, route }] : [];
    }),
  );
  for (const { to, route } of routes) {
    const target = machines[to]!;
    const previous = target.ssh;
    const match = /^(?:([^@]+)@)?(.+?)(?::(\d+))?$/.exec(route.ssh);
    machines[to] = {
      ...target,
      reach: target.reach ?? "auto",
      ssh: {
        ...previous,
        ...(match?.[1] ? { user: match[1] } : {}),
        ...(match?.[3] ? { port: Number(match[3]) } : {}),
        host: match?.[2] ?? route.ssh,
      },
    };
  }
  const projectIgnores = new Map<string, Set<string>>();
  for (const [key, reps] of Object.entries(layout.projectMounts)) {
    const title = layout.projectTitles[key];
    if (!title) continue;
    for (const ignore of reps.flatMap((rep) => rep.ignores ?? [])) {
      const set = projectIgnores.get(title) ?? new Set<string>();
      set.add(ignore);
      projectIgnores.set(title, set);
    }
  }
  const doc: MeshConfigDocument = {
    schema: 1,
    machines,
    ssh: { mode: routes.length ? "existing" : "managed" },
    links: {
      default: { files: "projects", replicas: true, threads: true },
      overrides: names.flatMap((a, i) =>
        names.slice(i + 1).map((b) => ({ between: [a, b] as const, files: "all" as const })),
      ),
    },
    projects: {
      defaults: { conflicts: "primary-wins", replica: "lite", ignore: [] },
      overrides: [...projectIgnores].map(([project, patterns]) => ({
        project,
        ignore: [...patterns],
      })),
    },
    replicas: { ignore: [...ignores], rules: [] },
    agents: { aliases: {} },
  };
  return { doc, bindings };
}
