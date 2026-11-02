import { addRecentFile, parseT3FileLink } from "@t3tools/client-runtime/files";
import type { EnvironmentId } from "@t3tools/contracts";

export const RECENT_FILES_STORAGE_PREFIX = "t3code:recent-files:";
export const RECENT_FILES_LIMIT = 12;

export function recentFilesStorageKey(environmentId: EnvironmentId): string {
  return `${RECENT_FILES_STORAGE_PREFIX}${environmentId}`;
}

export function readRecentFiles(storage: Pick<Storage, "getItem">, environmentId: EnvironmentId) {
  const raw = storage.getItem(recentFilesStorageKey(environmentId));
  if (raw === null) return [] as ReadonlyArray<string>;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function rememberRecentFile(
  storage: Pick<Storage, "getItem" | "setItem">,
  environmentId: EnvironmentId,
  absolutePath: string,
) {
  const next = addRecentFile(
    readRecentFiles(storage, environmentId),
    absolutePath,
    RECENT_FILES_LIMIT,
  );
  storage.setItem(recentFilesStorageKey(environmentId), JSON.stringify(next));
  return next;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/**
 * What the dialog's path field means: a pasted `t3-file:` link may name another
 * machine; a relative path joins the selected project's root; `~/` and absolute
 * paths stand alone.
 */
export function resolveOpenFilePath(input: {
  readonly value: string;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string | null;
}): { readonly environmentId: EnvironmentId; readonly absolutePath: string } | null {
  const value = input.value.trim();
  if (value === "") return null;
  const link = parseT3FileLink(value);
  if (link !== null) return link;
  if (isAbsolutePath(value) || value.startsWith("~/") || value.startsWith("~\\")) {
    return { environmentId: input.environmentId, absolutePath: value };
  }
  if (input.workspaceRoot === null) return null;
  const separator = input.workspaceRoot.includes("\\") ? "\\" : "/";
  const root = input.workspaceRoot.replace(/[\\/]+$/, "");
  return {
    environmentId: input.environmentId,
    absolutePath: `${root}${separator}${value}`,
  };
}

export interface OpenFileProject {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly title: string;
}

function normalizeForComparison(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

/** The project on `environmentId` whose root is the longest prefix of the path, if any. */
export function findProjectForFile(
  projects: ReadonlyArray<OpenFileProject>,
  environmentId: EnvironmentId,
  absolutePath: string,
): OpenFileProject | null {
  const target = normalizeForComparison(absolutePath);
  let best: OpenFileProject | null = null;
  let bestLength = -1;
  for (const project of projects) {
    if (project.environmentId !== environmentId) continue;
    const root = normalizeForComparison(project.workspaceRoot);
    if ((target === root || target.startsWith(`${root}/`)) && root.length > bestLength) {
      best = project;
      bestLength = root.length;
    }
  }
  return best;
}

/** Where the existing viewer reads from when the dialog opens a file. */
export function fileViewerContext(input: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly absolutePath: string;
  readonly projects: ReadonlyArray<OpenFileProject>;
}): {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly projectName: string;
} {
  const project = findProjectForFile(input.projects, input.environmentId, input.absolutePath);
  return project !== null
    ? {
        environmentId: input.environmentId,
        workspaceRoot: project.workspaceRoot,
        projectName: project.title,
      }
    : {
        environmentId: input.environmentId,
        // Absolute host paths ignore the root; this only anchors the viewer.
        workspaceRoot: "/",
        projectName: input.environmentLabel,
      };
}
