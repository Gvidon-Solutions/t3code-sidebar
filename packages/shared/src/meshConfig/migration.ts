import { defaultAgentAliases, machineByName } from "./index.ts";
import * as Schema from "effect/Schema";
import type { Json } from "../meshLayout/document.ts";
import {
  MeshConfigRevision,
  type MeshConfigDocument,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import type { MeshLayoutDocument } from "../meshLayout/document.ts";

const legacyMachine = Schema.decodeUnknownOption(
  Schema.Struct({
    reach: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.Struct({
          ssh: Schema.String,
          identityFile: Schema.optionalKey(Schema.String),
        }),
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
  projects: readonly { environmentId: string; path: string; title: string }[] = [],
) {
  if (Object.hasOwn(document, "mesh.config")) return undefined;
  const bindings: Record<string, string> = {};
  const migration: Record<string, { peerLabels: string[]; ssh?: Record<string, unknown> }> = {};
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
          ...(machine?.aliases ?? []),
          environmentId === self.environmentId ? self.label : undefined,
          peers.find((peer) => peer.environmentId === environmentId)?.label,
        ].filter((label): label is string => typeof label === "string"),
      ),
    ];
    migration[name] = {
      peerLabels: legacyLabels.flatMap((label) => [`T3 Code · ${label}`, label]),
    };
    machines[name] = {
      title,
      ...(machine?.tag ? { label: machine.tag } : {}),
      ...(machine?.color ? { color: machine.color } : {}),
    };
  }
  const names = Object.keys(bindings);
  const routes = names.flatMap((from) =>
    Object.entries(
      (() => {
        const environmentId = bindings[from]!;
        const decoded = legacyMachine(
          document[`machine/${encodeURIComponent(environmentId)}`]?.v ??
            layout.machines[environmentId],
        );
        return decoded._tag === "Some" ? (decoded.value.reach ?? {}) : {};
      })(),
    ).flatMap(([target, route]) => {
      const to = names.find((name) => bindings[name] === target);
      return to ? [{ from, to, route }] : [];
    }),
  );
  for (const { from, to, route } of routes) {
    const target = machines[to]!;
    const previous = target.ssh;
    const legacy = migration[to]!.ssh;
    const oldRoutes =
      typeof legacy?.routes === "object" && legacy.routes !== null ? legacy.routes : {};
    const match = /^(?:([^@]+)@)?(.+?)(?::(\d+))?$/.exec(route.ssh);
    migration[to]!.ssh = {
      ...legacy,
      host: match?.[2] ?? route.ssh,
      routes: { ...oldRoutes, [from]: route },
    };
    machines[to] = {
      ...target,
      reach: target.reach ?? "auto",
      ssh: {
        ...previous,
        host: match?.[2] ?? route.ssh,
        ...(match?.[1] ? { user: match[1] } : {}),
        ...(match?.[3] ? { port: Number(match[3]) } : {}),
      },
    };
  }
  const projectIgnores = new Map<string, Set<string>>();
  for (const [key, reps] of Object.entries(layout.projectMounts)) {
    const title =
      layout.projectTitles[key] ??
      projects.find((project) =>
        reps.some(
          (rep) => rep.environmentId === project.environmentId && rep.path === project.path,
        ),
      )?.title ??
      Object.entries(layout.projectTitles).find(
        ([alias]) => layout.projectAliases[alias] === key,
      )?.[1];
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
      overrides: [],
    },
    projects: {
      defaults: { conflicts: "primary-wins", replica: "lite", ignore: [] },
      overrides: [...projectIgnores].map(([project, patterns]) => ({
        project,
        ignore: [...patterns],
      })),
    },
    replicas: { ignore: [...ignores], rules: [] },
    agents: { aliases: defaultAgentAliases() },
  };
  return { doc, bindings, migration };
}

const decodeRevision = Schema.decodeUnknownOption(MeshConfigRevision);
export function extractConfigMigration(
  document: MeshLayoutDocument,
  h: string,
): MeshLayoutDocument {
  const entries: MeshLayoutDocument = {};
  for (const [key, entry] of Object.entries(document)) {
    if (!(key === "mesh.config" || key.startsWith("mesh.configHistory/"))) continue;
    const decoded = decodeRevision(entry.v);
    if (decoded._tag === "None") continue;
    const revision = decoded.value;
    const machines: Record<string, MeshConfigDocument["machines"][string]> = {};
    let changed = false;
    for (const [name, machine] of Object.entries(revision.doc.machines)) {
      const { legacyPeerLabels, ...visible } = machine;
      const { routes, ...ssh } = machine.ssh ?? {};
      const host = ssh.host;
      machines[name] = { ...visible, ...(machine.ssh ? { ssh } : {}) };
      if (legacyPeerLabels === undefined && routes === undefined) continue;
      changed = true;
      const metadataKey = `mesh.machineMigration/${encodeURIComponent(name)}`;
      const old = entries[metadataKey]?.v ?? document[metadataKey]?.v;
      const prior =
        old && typeof old === "object" && !Array.isArray(old) ? (old as Record<string, Json>) : {};
      const labels = Array.isArray(legacyPeerLabels)
        ? legacyPeerLabels.filter((value): value is string => typeof value === "string")
        : [];
      const priorLabels = Array.isArray(prior.peerLabels)
        ? prior.peerLabels.filter((value): value is string => typeof value === "string")
        : [];
      entries[metadataKey] = {
        h,
        v: {
          ...prior,
          peerLabels: [...new Set([...priorLabels, ...labels])],
          ...(host !== undefined || routes !== undefined
            ? {
                ssh: {
                  ...(typeof host === "string" ? { host } : {}),
                  ...(typeof routes === "object" && routes !== null
                    ? { routes: routes as Json }
                    : {}),
                },
              }
            : {}),
        },
      };
    }
    if (changed)
      entries[key] = {
        h,
        v: { ...(entry.v as Record<string, Json>), doc: { ...revision.doc, machines } } as Json,
      };
  }
  return entries;
}

const peerLabels = (config: MeshConfigDocument, name: string) => {
  const machine = machineByName(config, name);
  if (!machine) return [];
  const extra = Array.isArray(machine.legacyPeerLabels)
    ? machine.legacyPeerLabels.filter((label): label is string => typeof label === "string")
    : [];
  return [
    name,
    machine.title,
    machine.label,
    ...(Array.isArray(machine.aliases)
      ? machine.aliases.filter((alias): alias is string => typeof alias === "string")
      : []),
    ...extra,
  ].filter((label): label is string => typeof label === "string" && label.length > 0);
};

export const machineByPeerLabel = (
  config: MeshConfigDocument,
  bindings: Readonly<Record<string, string>>,
  peerLabel: string | undefined,
  migratedLabels: Readonly<Record<string, readonly string[]>> = {},
) => {
  if (peerLabel === undefined) return undefined;
  const compact = peerLabel.replace(/^T3 Code\s*·\s*/u, "").trim();
  const matches = Object.entries(bindings).filter(
    ([name]) =>
      [...peerLabels(config, name), ...(migratedLabels[name] ?? [])].includes(peerLabel) ||
      [...peerLabels(config, name), ...(migratedLabels[name] ?? [])].includes(compact),
  );
  return matches.length === 1
    ? {
        name: matches[0]![0],
        environmentId: matches[0]![1],
        machine: machineByName(config, matches[0]![0]),
      }
    : undefined;
};
