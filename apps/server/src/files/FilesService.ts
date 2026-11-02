// @effect-diagnostics nodeBuiltinImport:off - absolute host paths need native realpath and non-blocking opens.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import {
  FILES_LIST_DEFAULT_LIMIT,
  FilesError,
  type FilesListEntry,
  type FilesListInput,
  type FilesListResult,
  type FilesReadInput,
  type FilesReadResult,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";

/** Same preview limit as project file reads. */
export const FILES_READ_PREVIEW_BYTES = 1024 * 1024;
/** Beyond this a preview is refused instead of spending memory on bytes nobody reads. */
export const FILES_READ_HARD_MAX_BYTES = 64 * 1024 * 1024;

const failureOf = (cause: unknown): FilesError["reason"] => {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR"
    ? "not_found"
    : code === "EACCES" || code === "EPERM"
      ? "permission_denied"
      : "operation_failed";
};

const filesError = (
  reason: FilesError["reason"],
  absolutePath: string | undefined,
  cause?: unknown,
): FilesError => new FilesError({ reason, ...(absolutePath ? { absolutePath } : {}), cause });

export class FilesService extends Context.Service<
  FilesService,
  {
    /** Reads any file on this machine, inside or outside a project. */
    readonly read: (input: FilesReadInput) => Effect.Effect<FilesReadResult, FilesError>;
    /** Lists a folder or completes the last segment of a path, for the open-file dialog. */
    readonly list: (input: FilesListInput) => Effect.Effect<FilesListResult, FilesError>;
  }
>()("t3/files/FilesService") {}

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const isServerInternalPath = yield* makeIsServerInternalPath;

  const expand = (requestedPath: string) => expandHomePath(requestedPath.trim(), home).trim();

  const realPath = Effect.fn("FilesService.realPath")(function* (absolutePath: string) {
    return yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(absolutePath),
      catch: (cause) => filesError(failureOf(cause), absolutePath, cause),
    });
  });

  const realDirectory = Effect.fn("FilesService.realDirectory")(function* (absolutePath: string) {
    return yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(absolutePath),
      catch: (cause) =>
        filesError(
          (cause as NodeJS.ErrnoException).code === "ENOTDIR" ? "not_directory" : failureOf(cause),
          absolutePath,
          cause,
        ),
    });
  });

  const read: FilesService["Service"]["read"] = Effect.fn("FilesService.read")(function* (input) {
    const requested = expand(input.absolutePath);
    if (!path.isAbsolute(requested)) {
      return yield* filesError("invalid_path", input.absolutePath);
    }
    const realTarget = yield* realPath(requested);
    if (yield* isServerInternalPath(realTarget)) {
      return yield* filesError("permission_denied", requested);
    }

    const handle = yield* Effect.tryPromise({
      // A FIFO would otherwise block the read; Windows has no such flag.
      try: () =>
        NodeFSP.open(realTarget, NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0)),
      catch: (cause) => filesError(failureOf(cause), requested, cause),
    });
    return yield* Effect.acquireUseRelease(
      Effect.succeed(handle),
      (openHandle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => openHandle.stat(),
            catch: (cause) => filesError(failureOf(cause), realTarget, cause),
          });
          if (!stat.isFile()) {
            return yield* filesError("not_file", requested);
          }
          if (stat.size > FILES_READ_HARD_MAX_BYTES) {
            return yield* filesError("too_large", requested);
          }
          const bytesToRead = Math.min(stat.size, FILES_READ_PREVIEW_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => openHandle.read(buffer, 0, bytesToRead, 0),
            catch: (cause) => filesError(failureOf(cause), realTarget, cause),
          });
          const bytes = buffer.subarray(0, bytesRead);
          if (bytes.includes(0)) {
            return yield* filesError("binary", requested);
          }
          const truncated = stat.size > FILES_READ_PREVIEW_BYTES;
          return {
            absolutePath: realTarget,
            contents: new TextDecoder("utf-8").decode(bytes, { stream: truncated }),
            byteLength: stat.size,
            truncated,
          } satisfies FilesReadResult;
        }),
      (openHandle) => Effect.promise(() => openHandle.close()).pipe(Effect.ignore),
    );
  });

  const list: FilesService["Service"]["list"] = Effect.fn("FilesService.list")(function* (input) {
    const requested = expand(input.partialPath);
    if (!path.isAbsolute(requested)) {
      return yield* filesError("invalid_path", input.partialPath);
    }
    const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath.trim() === "~";
    const parentPath = endsWithSeparator ? requested : path.dirname(requested);
    const prefix = endsWithSeparator ? "" : path.basename(requested);
    const realParent = yield* realDirectory(parentPath);
    if (yield* isServerInternalPath(realParent)) {
      return yield* filesError("permission_denied", parentPath);
    }
    const parentStat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(realParent),
      catch: (cause) => filesError(failureOf(cause), parentPath, cause),
    });
    if (!parentStat.isDirectory()) {
      return yield* filesError("not_directory", parentPath);
    }

    const dirents = yield* Effect.tryPromise({
      try: () => NodeFSP.readdir(realParent, { withFileTypes: true }),
      catch: (cause) => filesError(failureOf(cause), parentPath, cause),
    });
    const showHidden = endsWithSeparator || prefix.startsWith(".");
    const lowerPrefix = prefix.toLowerCase();
    const entries: Array<FilesListEntry> = [];
    for (const dirent of dirents) {
      if (!dirent.name.toLowerCase().startsWith(lowerPrefix)) continue;
      if (!showHidden && dirent.name.startsWith(".")) continue;
      entries.push({
        name: dirent.name,
        absolutePath: path.join(realParent, dirent.name),
        kind: dirent.isDirectory() ? "directory" : dirent.isFile() ? "file" : "other",
      });
    }
    entries.sort(
      (left, right) =>
        (left.kind === "directory" ? 0 : 1) - (right.kind === "directory" ? 0 : 1) ||
        left.name.localeCompare(right.name),
    );
    const limit = input.limit ?? FILES_LIST_DEFAULT_LIMIT;
    return { parentPath: realParent, entries: entries.slice(0, limit) };
  });

  return FilesService.of({ read, list });
});

export const layer = Layer.effect(FilesService, make);
