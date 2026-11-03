import {
  EnvironmentId,
  NonNegativeInt,
  Project,
  ReplicaError,
  type SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import {
  logicalProjectKeyForRecord,
  opaqueProjectId,
  meshMachineLabel,
} from "@t3tools/shared/meshLayout";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { callRouted } from "../mesh/MeshRouting.ts";
import { Routes } from "../mesh/MeshRelay.ts";
import type { PeerLinks } from "../peer/PeerLinks.ts";
import type { PeerMcpClient } from "../peer/PeerMcpClient.ts";

const Page = Schema.Struct({
  projects: Schema.Array(Project),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
const limits = { runtimeMode: "approval-required", interactionMode: "default" } as const;
const normalized = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

export const lookupMeshProject = Effect.fn("ProjectReplicaService.lookupMeshProject")(function* (
  config: SidebarWorkspacesConfig,
  query: string,
  self: string,
  local: readonly Project[],
  transport?: { readonly links: PeerLinks["Service"]; readonly peers: PeerMcpClient["Service"] },
) {
  const records = local.map((project) => ({ environmentId: self, project }));
  const failures: string[] = [];
  const enabled = transport ? yield* transport.links.enabled : false;
  if (transport && !enabled)
    failures.push("Linked environments is off on this machine. Turn it on in Settings › Mesh.");
  if (transport && enabled) {
    const direct = yield* transport.links.list.pipe(
      Effect.mapError(
        (error) =>
          new ReplicaError({ reason: "unreachable", message: error.message, cause: error }),
      ),
    );
    const targets = new Set([
      ...Object.keys(config.machines),
      ...Object.values(config.projectMounts).flatMap((reps) =>
        reps.map((rep) => rep.environmentId),
      ),
      ...direct.filter((link) => link.status !== "expired").map((link) => link.environmentId),
    ]);
    const discoveredRoutes = yield* Effect.forEach(
      direct.filter((link) => link.access === "full-access" && link.status !== "expired"),
      (link) =>
        transport.peers
          .call({
            environmentId: link.environmentId,
            tool: "t3_mesh_routes",
            arguments: {},
            limits,
            success: Routes,
          })
          .pipe(
            Effect.timeout("10 seconds"),
            Effect.catch((error) =>
              Effect.logWarning("Mesh project route discovery failed", {
                machine: link.label,
                message: error.message,
              }).pipe(Effect.as([] as readonly string[])),
            ),
          ),
      { concurrency: 4 },
    );
    for (const target of discoveredRoutes.flat()) targets.add(target);
    targets.delete(self);
    yield* Effect.forEach(
      [...targets].sort(),
      (environmentId) =>
        Effect.gen(function* () {
          const fetched: Project[] = [];
          let cursor: number | null = 0;
          const seen = new Set<number>();
          while (cursor !== null) {
            if (seen.has(cursor))
              return yield* new ReplicaError({
                reason: "storage",
                message: "The remote project list did not advance to its next page.",
              });
            seen.add(cursor);
            const page: typeof Page.Type = yield* callRouted(
              { ...transport, self },
              {
                environmentId: EnvironmentId.make(environmentId),
                tool: "t3_project_list",
                arguments: { cursor, limit: 100 },
                limits,
                success: Page,
              },
            ).pipe(
              Effect.mapError(
                (error) =>
                  new ReplicaError({ reason: "unreachable", message: error.message, cause: error }),
              ),
            );
            fetched.push(...page.projects);
            cursor = page.nextCursor;
          }
          records.push(...fetched.map((project) => ({ environmentId, project })));
        }).pipe(
          Effect.timeout("20 seconds"),
          Effect.catch((error) => {
            const message = `${meshMachineLabel(config, environmentId, direct.find((link) => link.environmentId === environmentId)?.label ?? "Unknown machine")}: ${error.message}`;
            failures.push(message);
            return Effect.logWarning("Mesh project lookup incomplete", { message });
          }),
        ),
      { concurrency: 4 },
    );
  }
  const matching = records.filter(
    ({ project }) => project.id === query || normalized(project.title) === normalized(query),
  );
  const groups = new Map<string, typeof records>();
  for (const record of matching) {
    const fallback = opaqueProjectId(`${record.environmentId}:${record.project.workspaceRoot}`);
    const key = logicalProjectKeyForRecord(
      config,
      { ...record.project, environmentId: record.environmentId },
      fallback,
    );
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  if (groups.size === 1) {
    const [key, records] = [...groups.entries()][0]!;
    if (
      !config.projectMounts[key] &&
      !config.projectTitles[key] &&
      !Object.values(config.projectAliases).includes(key)
    ) {
      const titled = Object.entries(config.projectTitles).filter(
        ([, title]) => normalized(title) === normalized(records[0]!.project.title),
      );
      if (titled.length === 1) {
        groups.delete(key);
        groups.set(titled[0]![0], records);
      }
    }
  }
  if (groups.size > 1)
    return yield* new ReplicaError({
      reason: "not_found",
      message:
        "More than one project has this name. Choose a project from its machine or use its id.",
    });
  const found = [...groups.entries()][0];
  if (!found) {
    const known = Object.entries(config.projectTitles).filter(
      ([id, title]) => id === query || normalized(title) === normalized(query),
    );
    if (known.length === 1) return { logicalKey: known[0]![0], records: [] };
  }
  if (!found)
    return yield* new ReplicaError({
      reason: failures.length ? "unreachable" : "not_found",
      message: failures.length
        ? `Could not complete the mesh project search. ${failures.slice(0, 3).join("; ")}`
        : "Project was not found in the mesh.",
    });
  return {
    logicalKey: found[0],
    records: found[1].sort(
      (a, b) =>
        a.environmentId.localeCompare(b.environmentId) || a.project.id.localeCompare(b.project.id),
    ),
  };
});
