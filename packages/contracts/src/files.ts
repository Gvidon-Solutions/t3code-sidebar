import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
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
