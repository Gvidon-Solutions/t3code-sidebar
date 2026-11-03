import type { SidebarWorkspacesConfig } from "@t3tools/contracts";
import { normalizeRepresentationPath } from "./representationPath.ts";

export function logicalProjectKeyForRecord(
  config: Pick<SidebarWorkspacesConfig, "projectMounts" | "projectAliases">,
  project: {
    readonly environmentId: string;
    readonly workspaceRoot: string;
    readonly title?: string | undefined;
    readonly repositoryIdentity?:
      | {
          readonly canonicalKey: string;
          readonly origin?: { readonly canonicalKey: string };
        }
      | null
      | undefined;
  },
  fallback: string,
): string {
  const path = normalizeRepresentationPath(project.workspaceRoot);
  const represented = Object.keys(config.projectMounts)
    .sort()
    .find((key) =>
      config.projectMounts[key]!.some(
        (rep) =>
          rep.environmentId === project.environmentId &&
          normalizeRepresentationPath(rep.path) === path,
      ),
    );
  const candidates = [
    `${project.environmentId}:${path}`,
    `${project.environmentId}:${project.workspaceRoot}`,
    fallback,
    project.repositoryIdentity?.origin?.canonicalKey ?? project.repositoryIdentity?.canonicalKey,
    project.title ? `title:${project.title.trim().replace(/\s+/g, " ").toLowerCase()}` : undefined,
    project.title ? `title:${project.title}` : undefined,
  ];
  let key =
    represented ??
    candidates.find((candidate) => candidate && config.projectAliases[candidate]) ??
    fallback;
  const visited = new Set<string>();
  while (config.projectAliases[key]) {
    if (visited.has(key)) return [...visited, key].sort()[0]!;
    visited.add(key);
    key = config.projectAliases[key]!;
  }
  return key;
}
