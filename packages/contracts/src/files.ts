import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** T3 Mesh (fork): files anywhere, on any machine that holds them. */
export const FILES_PATH_MAX_LENGTH = 4096;
export const FILES_LIST_DEFAULT_LIMIT = 200;
export const FILES_LIST_MAX_LIMIT = 1000;

const AbsoluteHostPath = TrimmedNonEmptyString.check(Schema.isMaxLength(FILES_PATH_MAX_LENGTH));

/**
 * A file or folder on the machine named by `environmentId`; omit it for the
 * server answering the call. Paths are absolute or start with `~/`.
 */
export const FilesReadInput = Schema.Struct({
  environmentId: Schema.optionalKey(EnvironmentId),
  absolutePath: AbsoluteHostPath,
});
export type FilesReadInput = typeof FilesReadInput.Type;

export const FilesReadResult = Schema.Struct({
  /** The resolved path, with symlinks followed. */
  absolutePath: TrimmedNonEmptyString,
  contents: Schema.String,
  byteLength: NonNegativeInt,
  /** The preview is the first `FILES_READ_PREVIEW_BYTES` of a larger file. */
  truncated: Schema.Boolean,
  mimeType: Schema.optionalKey(TrimmedNonEmptyString),
});
export type FilesReadResult = typeof FilesReadResult.Type;

export const FilesListInput = Schema.Struct({
  environmentId: Schema.optionalKey(EnvironmentId),
  /**
   * A directory (`/srv/app/`), or the start of one (`/srv/ap`). Its parent is
   * listed and entries are filtered by the last segment.
   */
  partialPath: AbsoluteHostPath,
  limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(FILES_LIST_MAX_LIMIT))),
});
export type FilesListInput = typeof FilesListInput.Type;

export const FilesListEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  absolutePath: TrimmedNonEmptyString,
  kind: Schema.Literals(["file", "directory", "other"]),
});
export type FilesListEntry = typeof FilesListEntry.Type;

export const FilesListResult = Schema.Struct({
  parentPath: TrimmedNonEmptyString,
  entries: Schema.Array(FilesListEntry),
});
export type FilesListResult = typeof FilesListResult.Type;

/** Existence and kind for one host path, used by the resolver and file pickers. */
export const FilesStatInput = Schema.Struct({
  environmentId: Schema.optionalKey(EnvironmentId),
  absolutePath: AbsoluteHostPath,
});
export type FilesStatInput = typeof FilesStatInput.Type;

export const FilesStatKind = Schema.Literals(["file", "directory", "other"]);
export type FilesStatKind = typeof FilesStatKind.Type;

export const FilesStatResult = Schema.Struct({
  absolutePath: TrimmedNonEmptyString,
  kind: FilesStatKind,
  byteLength: Schema.optionalKey(NonNegativeInt),
  mtimeMs: Schema.optionalKey(Schema.Number),
});
export type FilesStatResult = typeof FilesStatResult.Type;

/** One base64 chunk of a host file, so a replica server can proxy bytes from its primary. */
export const FILES_READ_BYTES_MAX = 8 * 1024 * 1024;

export const FilesReadBytesInput = Schema.Struct({
  environmentId: Schema.optionalKey(EnvironmentId),
  absolutePath: AbsoluteHostPath,
  offset: NonNegativeInt,
  length: PositiveInt.check(Schema.isLessThanOrEqualTo(FILES_READ_BYTES_MAX)),
});
export type FilesReadBytesInput = typeof FilesReadBytesInput.Type;

export const FilesReadBytesResult = Schema.Struct({
  absolutePath: TrimmedNonEmptyString,
  offset: NonNegativeInt,
  bytes: Schema.String,
  totalBytes: NonNegativeInt,
});
export type FilesReadBytesResult = typeof FilesReadBytesResult.Type;

export const FILES_LOCATE_MAX_CANDIDATES = 50;

/** How the resolver found the target; shown to people as a short caption. */
export const FilesLocateVia = Schema.Literals([
  "exact",
  "cwd",
  "ancestor",
  "project-root",
  "suffix",
  "basename",
  "representation-map",
  "other-machine",
  "explicit-machine",
]);
export type FilesLocateVia = typeof FilesLocateVia.Type;

export const FilesLocateStatus = Schema.Literals(["found", "choose", "notFound"]);
export type FilesLocateStatus = typeof FilesLocateStatus.Type;

export const FilesLocateInput = Schema.Struct({
  /** The path exactly as the person or agent wrote it. */
  rawPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILES_PATH_MAX_LENGTH)),
  /** The thread whose worktree the relative path belongs to. */
  threadId: Schema.optionalKey(ThreadId),
  /** The thread's directory when the caller already knows it. */
  cwd: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(FILES_PATH_MAX_LENGTH))),
  /** An explicitly named machine (`t3-file:`, `--on`, `ui_open.environmentId`). */
  environmentId: Schema.optionalKey(EnvironmentId),
  intent: Schema.optionalKey(Schema.Literal("open")),
});
export type FilesLocateInput = typeof FilesLocateInput.Type;

export const FilesLocateCandidate = Schema.Struct({
  environmentId: EnvironmentId,
  absolutePath: TrimmedNonEmptyString,
  kind: Schema.Literals(["file", "directory"]),
  via: FilesLocateVia,
  line: Schema.optionalKey(PositiveInt),
  column: Schema.optionalKey(PositiveInt),
  inProject: Schema.Boolean,
  /** The thread's own representation does not have the file; another one serves it. */
  notSynced: Schema.optionalKey(Schema.Boolean),
  byteLength: Schema.optionalKey(NonNegativeInt),
  mtimeMs: Schema.optionalKey(Schema.Number),
  touchedByThread: Schema.Boolean,
  /** The path as the person should see it after remapping. */
  displayPath: TrimmedNonEmptyString,
  /** The representation root the file lives under, when one contains it. */
  root: Schema.optionalKey(TrimmedNonEmptyString),
});
export type FilesLocateCandidate = typeof FilesLocateCandidate.Type;

export const FilesLocateTried = Schema.Struct({
  tier: TrimmedNonEmptyString,
  environmentId: Schema.optionalKey(EnvironmentId),
  detail: Schema.optionalKey(TrimmedNonEmptyString),
});
export type FilesLocateTried = typeof FilesLocateTried.Type;

export const FilesLocateResult = Schema.Struct({
  status: FilesLocateStatus,
  target: Schema.optionalKey(FilesLocateCandidate),
  candidates: Schema.optionalKey(Schema.Array(FilesLocateCandidate)),
  tried: Schema.Array(FilesLocateTried),
  /** The machine the resolver ran on (the thread's machine). */
  environmentId: EnvironmentId,
  /** The logical project title, when the thread belongs to one. */
  projectTitle: Schema.optionalKey(TrimmedNonEmptyString),
  /** The thread's own directory, when one was resolved. */
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
  /** True when the thread's worktree is gone and a fallback directory was used. */
  worktreeRemoved: Schema.optionalKey(Schema.Boolean),
});
export type FilesLocateResult = typeof FilesLocateResult.Type;

export const FilesFailure = Schema.Literals([
  "invalid_path",
  "not_found",
  "permission_denied",
  "not_file",
  "not_directory",
  "binary",
  "too_large",
  "unavailable",
  "operation_failed",
]);
export type FilesFailure = typeof FilesFailure.Type;

const FILES_FAILURE_MESSAGES: Record<FilesFailure, string> = {
  invalid_path: "The path must be absolute or start with ~/.",
  not_found: "The file or folder was not found.",
  permission_denied: "This machine does not allow reading that path.",
  not_file: "The path is a folder or special file, not a regular file.",
  not_directory: "The path is not a folder.",
  binary: "The file is binary and cannot be previewed as text.",
  too_large: "The file is too large to preview.",
  unavailable: "The machine holding that path is not reachable.",
  operation_failed: "The path could not be read.",
};

export class FilesError extends Schema.TaggedError<FilesError>()("FilesError", {
  reason: FilesFailure,
  absolutePath: Schema.optionalKey(TrimmedNonEmptyString),
  message: TrimmedNonEmptyString,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly reason: FilesFailure;
    readonly absolutePath?: string | undefined;
    readonly message?: string | undefined;
    readonly cause?: unknown;
  }) {
    super({
      ...props,
      message: props.message ?? FILES_FAILURE_MESSAGES[props.reason],
    } as any);
  }
}
