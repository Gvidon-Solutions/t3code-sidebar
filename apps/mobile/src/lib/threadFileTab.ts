import type { ThreadTabFile } from "./threadTabs";

/** The route params `ThreadFile` receives from a resolver outcome or a legacy file open. */
export interface ThreadFileRouteParams {
  readonly environmentId?: string | string[] | undefined;
  readonly threadId?: string | string[] | undefined;
  readonly path?: string | string[] | undefined;
  readonly line?: string | string[] | undefined;
  readonly cwd?: string | string[] | undefined;
  readonly projectName?: string | string[] | undefined;
  readonly fileTarget?: string | string[] | undefined;
  readonly fileEnvironmentId?: string | string[] | undefined;
  readonly sourceEnvironmentId?: string | string[] | undefined;
  readonly rawPath?: string | string[] | undefined;
  readonly displayPath?: string | string[] | undefined;
  readonly resolvedPath?: string | string[] | undefined;
  readonly notSynced?: string | string[] | undefined;
  readonly worktreeRemoved?: string | string[] | undefined;
  readonly outsideProject?: string | string[] | undefined;
}

export interface ThreadFileTabMapping {
  /** The pager tab key. */
  readonly path: string;
  readonly line: string | null;
  /** Present when the resolver picked the file; absent for a legacy file open. */
  readonly tabFile?: ThreadTabFile;
}

const first = (value: string | string[] | undefined): string | null => {
  const result = Array.isArray(value) ? value[0] : value;
  return result === undefined || result.trim().length === 0 ? null : result;
};

const normalizePath = (value: string | string[] | undefined): string | null => {
  const result = Array.isArray(value) ? value.join("/") : value;
  return result === undefined || result.trim().length === 0 ? null : result;
};

/**
 * Every resolver outcome (same machine, other machine, picker, `t3-file:`,
 * outside project, removed worktree) keeps its resolved target on the tab.
 * A legacy file open has no target and stays a path tab.
 */
export function threadFileTab(params: ThreadFileRouteParams): ThreadFileTabMapping | null {
  const path = normalizePath(params.path);
  if (path === null) return null;
  const line = first(params.line) ?? null;
  if (first(params.fileTarget) !== "resolved") return { path, line };
  const environmentId = first(params.fileEnvironmentId) ?? first(params.environmentId);
  if (environmentId === null) return { path, line };
  const cwd = first(params.cwd) ?? "";
  const sourceEnvironmentId = first(params.sourceEnvironmentId);
  const projectName = first(params.projectName);
  const rawPath = first(params.rawPath);
  const displayPath = first(params.displayPath);
  const resolvedPath = first(params.resolvedPath) ?? path;
  const notSynced = first(params.notSynced) !== null;
  const worktreeRemoved = first(params.worktreeRemoved) !== null;
  const outsideProject = first(params.outsideProject) !== null;
  return {
    path,
    line,
    tabFile: {
      environmentId,
      absolutePath: resolvedPath,
      cwd,
      ...(sourceEnvironmentId === null ? {} : { sourceEnvironmentId }),
      ...(projectName === null ? {} : { projectName }),
      ...(rawPath === null ? {} : { rawPath }),
      ...(displayPath === null ? {} : { displayPath }),
      ...(notSynced ? { notSynced: true } : {}),
      ...(worktreeRemoved ? { worktreeRemoved: true } : {}),
      ...(outsideProject ? { outsideProject: true } : {}),
    },
  };
}

/** The target a resolver, picker or `ui_open` hands to the pager tab. */
export interface ResolvedFileTarget {
  readonly environmentId: string;
  readonly absolutePath: string;
  readonly line?: number;
  readonly root?: string;
  readonly rawPath?: string;
  readonly displayPath?: string;
  readonly projectTitle?: string;
  readonly inProject?: boolean;
  readonly notSynced?: boolean;
  readonly worktreeRemoved?: boolean;
  readonly outsideProject?: boolean;
}

/**
 * The route params that open `target` as a tab of `threadEnvironmentId`.
 * A project-relative display path is the tab key for the thread's own in-project
 * file; every other outcome keeps its absolute path so the tab is unambiguous.
 */
export function resolvedFileTabParams(
  threadEnvironmentId: string,
  threadId: string,
  target: ResolvedFileTarget,
) {
  const display = target.displayPath;
  const useDisplayKey =
    target.environmentId === threadEnvironmentId &&
    target.inProject !== false &&
    target.worktreeRemoved !== true &&
    display !== undefined &&
    !display.startsWith("/");
  return {
    environmentId: threadEnvironmentId,
    threadId,
    fileTarget: "resolved",
    fileEnvironmentId: target.environmentId,
    path: useDisplayKey ? display : target.absolutePath,
    resolvedPath: target.absolutePath,
    ...(target.root === undefined ? {} : { cwd: target.root }),
    sourceEnvironmentId: threadEnvironmentId,
    ...(target.projectTitle === undefined ? {} : { projectName: target.projectTitle }),
    ...(target.rawPath === undefined ? {} : { rawPath: target.rawPath }),
    ...(display === undefined ? {} : { displayPath: display }),
    ...(target.line === undefined ? {} : { line: String(target.line) }),
    ...(target.worktreeRemoved ? { worktreeRemoved: "1" } : {}),
    ...(target.notSynced ? { notSynced: "1" } : {}),
    ...(target.outsideProject || target.inProject === false ? { outsideProject: "1" } : {}),
  };
}
