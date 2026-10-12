import type { SidebarWorkspace, SidebarWorkspacesConfig } from "@t3tools/contracts";

// Workspace sidebar (fork feature): the pure rules shared by web and mobile —
// which workspace a project lands in, tile faces and colours, ordering.

export const WORKSPACE_COLORS = [
  "#6d8cff",
  "#e0795b",
  "#4fb58f",
  "#c27bd6",
  "#d9a640",
  "#4fa9c9",
  "#de6b8f",
  "#8f9a5a",
] as const;

/** `icon` values with this prefix name a built-in glyph; anything else is a short label. */
export const WORKSPACE_GLYPH_PREFIX = "glyph:";
/** Longest tile label, in user-perceived characters (an emoji counts as one). */
export const WORKSPACE_LABEL_MAX = 2;

// Hermes (mobile) has no Intl.Segmenter; code points are close enough there.
const graphemes = (value: string): string[] =>
  typeof Intl.Segmenter === "function"
    ? Array.from(
        // oxlint-disable-next-line t3code/no-hermes-unsupported-apis -- Guarded by the typeof check.
        new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
        (part) => part.segment,
      )
    : Array.from(value);

/** Trims a typed tile label to its first few characters; null when nothing is left. */
export function normalizeWorkspaceLabel(raw: string): string | null {
  const label = graphemes(raw.trim()).slice(0, WORKSPACE_LABEL_MAX).join("").trim();
  return label.length > 0 ? label : null;
}

export type WorkspaceMarkSpec = { kind: "glyph"; glyph: string } | { kind: "text"; text: string };

/** What a tile shows: a built-in glyph, the custom label, or the name's first letter. */
export function workspaceMark(
  workspace: Pick<SidebarWorkspace, "name" | "icon">,
): WorkspaceMarkSpec {
  const icon = workspace.icon?.trim();
  if (icon?.startsWith(WORKSPACE_GLYPH_PREFIX)) {
    return { kind: "glyph", glyph: icon.slice(WORKSPACE_GLYPH_PREFIX.length) };
  }
  const label = icon ? normalizeWorkspaceLabel(icon) : null;
  if (label) return { kind: "text", text: label };
  const letter = graphemes(workspace.name.trim())[0];
  return { kind: "text", text: letter ? letter.toUpperCase() : "?" };
}

export function workspaceColor(workspace: Pick<SidebarWorkspace, "id" | "color">): string {
  if (workspace.color) return workspace.color;
  let hash = 0;
  for (const char of workspace.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return WORKSPACE_COLORS[hash % WORKSPACE_COLORS.length]!;
}

const globCache = new Map<string, RegExp>();

/** `*` matches within one path segment, `**` across segments. Case-sensitive. */
export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const regExp = new RegExp(`^${source}$`);
  globCache.set(glob, regExp);
  return regExp;
}

export interface WorkspaceProjectIdentity {
  readonly projectKey: string;
  /** Workspace roots of every member project (one per environment). */
  readonly workspaceRoots: readonly string[];
}

/**
 * The workspace a project belongs to: explicit assignment, then the first
 * matching rule, then the default (or first) workspace. Null only when there
 * are no workspaces at all.
 */
export function resolveProjectWorkspaceId(
  project: WorkspaceProjectIdentity,
  config: SidebarWorkspacesConfig,
): string | null {
  const known = new Set(config.workspaces.map((workspace) => workspace.id));
  const assigned = config.assignments[project.projectKey];
  if (assigned !== undefined && known.has(assigned)) return assigned;
  for (const rule of config.rules) {
    if (!known.has(rule.workspace)) continue;
    const pattern = globToRegExp(rule.match);
    if (project.workspaceRoots.some((root) => pattern.test(root))) return rule.workspace;
  }
  return effectiveDefaultWorkspaceId(config);
}

/**
 * The workspace unplaced projects fall into: the configured default, or the
 * first workspace when that is unset or gone. It is the one workspace that
 * can't be deleted, so there is always somewhere for projects to land.
 */
export function effectiveDefaultWorkspaceId(config: SidebarWorkspacesConfig): string | null {
  const configured = config.defaultWorkspace;
  if (configured !== null && config.workspaces.some((workspace) => workspace.id === configured)) {
    return configured;
  }
  return config.workspaces[0]?.id ?? null;
}

/**
 * Moves a workspace so it sits before `beforeIndex` (a slot in the current
 * order, 0..length) and returns the new order; unknown ids leave it as is.
 */
export function reorderWorkspaces<T extends { readonly id: string }>(
  workspaces: readonly T[],
  workspaceId: string,
  beforeIndex: number,
): readonly T[] {
  const from = workspaces.findIndex((workspace) => workspace.id === workspaceId);
  if (from < 0) return workspaces;
  const moved = workspaces[from]!;
  const insertAt = Math.max(
    0,
    Math.min(beforeIndex > from ? beforeIndex - 1 : beforeIndex, workspaces.length - 1),
  );
  if (insertAt === from) return workspaces;
  const next = workspaces.filter((_, index) => index !== from);
  next.splice(insertAt, 0, moved);
  return next;
}

/**
 * A workspace's projects in the user's order (`config.projectOrder`).
 * Projects the order doesn't list yet go on top, newest first, so a new
 * project shows up where it is easy to find and nothing moves on activity.
 */
export function sortWorkspaceProjects<T>(
  projects: readonly T[],
  projectOrder: readonly string[],
  identity: (project: T) => { readonly projectKey: string; readonly createdAt: string | null },
): T[] {
  const rank = new Map(projectOrder.map((projectKey, index) => [projectKey, index] as const));
  const created = (project: T) => Date.parse(identity(project).createdAt ?? "") || 0;
  const unlisted: T[] = [];
  const listed: T[] = [];
  for (const project of projects) {
    (rank.has(identity(project).projectKey) ? listed : unlisted).push(project);
  }
  unlisted.sort((left, right) => created(right) - created(left));
  listed.sort(
    (left, right) => rank.get(identity(left).projectKey)! - rank.get(identity(right).projectKey)!,
  );
  return [...unlisted, ...listed];
}

/**
 * Moves `projectKey` so it sits before `beforeKey` (null: last) in
 * `sequence`, one workspace's projects as shown, and returns the new
 * `projectOrder`. Keys of other workspaces keep their relative order.
 */
export function moveProjectInOrder(
  projectOrder: readonly string[],
  sequence: readonly string[],
  projectKey: string,
  beforeKey: string | null,
): string[] {
  const next = sequence.filter((key) => key !== projectKey);
  const at = beforeKey === null ? -1 : next.indexOf(beforeKey);
  next.splice(at < 0 ? next.length : at, 0, projectKey);
  const moved = new Set(next);
  return [...next, ...projectOrder.filter((key) => !moved.has(key))];
}

/** Lowercase slug for a new workspace id, unique against `taken`. */
export function makeWorkspaceId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9а-яё]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "workspace";
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${base}-${suffix}`;
  return candidate;
}

/** Appends `Workspace N` in the first colour no workspace uses yet; returns its id too. */
export function addWorkspace(config: SidebarWorkspacesConfig): {
  readonly config: SidebarWorkspacesConfig;
  readonly id: string;
} {
  const name = `Workspace ${config.workspaces.length + 1}`;
  const id = makeWorkspaceId(name, new Set(config.workspaces.map((workspace) => workspace.id)));
  const used = new Set(config.workspaces.map((workspace) => workspaceColor(workspace)));
  const color = WORKSPACE_COLORS.find((candidate) => !used.has(candidate)) ?? WORKSPACE_COLORS[0];
  return { config: { ...config, workspaces: [...config.workspaces, { id, name, color }] }, id };
}

/** Edits one workspace; a null `icon` returns the tile to the name's first letter. */
export function updateWorkspace(
  config: SidebarWorkspacesConfig,
  workspaceId: string,
  patch: {
    readonly name?: string;
    readonly color?: string;
    readonly icon?: string | null;
  },
): SidebarWorkspacesConfig {
  return {
    ...config,
    workspaces: config.workspaces.map((workspace) => {
      if (workspace.id !== workspaceId) return workspace;
      const { icon: previousIcon, ...rest } = workspace;
      const icon = patch.icon === undefined ? previousIcon : (patch.icon ?? undefined);
      return {
        ...rest,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.color === undefined ? {} : { color: patch.color }),
        ...(icon === undefined ? {} : { icon }),
      };
    }),
  };
}

/**
 * Deletes a workspace; its projects fall back to the default workspace and no
 * threads are touched. The default itself can't be deleted (returned as is).
 */
export function deleteWorkspace(
  config: SidebarWorkspacesConfig,
  workspaceId: string,
): SidebarWorkspacesConfig {
  // Pinning the default keeps it put when the first workspace goes.
  const defaultWorkspace = effectiveDefaultWorkspaceId(config);
  if (defaultWorkspace === workspaceId) return config;
  return {
    ...config,
    workspaces: config.workspaces.filter((workspace) => workspace.id !== workspaceId),
    assignments: Object.fromEntries(
      Object.entries(config.assignments).filter(([, target]) => target !== workspaceId),
    ),
    rules: config.rules.filter((rule) => rule.workspace !== workspaceId),
    defaultWorkspace,
  };
}
