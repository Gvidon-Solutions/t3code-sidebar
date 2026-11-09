import { FilesError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { FileLocator } from "../../../files/FileLocator.ts";
import { FILES_REASON_PREFIX } from "../../../files/FilesRpc.ts";
import * as FilesService from "../../../files/FilesService.ts";
import { locateContextFor } from "../../../files/locateContext.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { FilesToolkit } from "./tools.ts";

const asFailure = (error: FilesError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "permission_denied"
        ? "capability_denied"
        : error.reason === "not_found" ||
            error.reason === "not_file" ||
            error.reason === "not_directory" ||
            error.reason === "invalid_path"
          ? "invalid_request"
          : "orchestration_error",
    // The reason travels in the text so a relayed or forwarded call can rebuild the FilesError.
    message: `${FILES_REASON_PREFIX}${error.reason}] ${error.message}`,
  });

export const layer = McpToolAccess.toLayer(FilesToolkit, {
  t3_files_read: McpToolAccess.reads(({ absolutePath }) =>
    Effect.gen(function* () {
      const files = yield* FilesService.FilesService;
      return yield* files.read({ absolutePath }).pipe(Effect.mapError(asFailure));
    }),
  ),
  t3_files_list: McpToolAccess.reads(({ partialPath, limit }) =>
    Effect.gen(function* () {
      const files = yield* FilesService.FilesService;
      return yield* files
        .list({ partialPath, ...(limit === undefined ? {} : { limit }) })
        .pipe(Effect.mapError(asFailure));
    }),
  ),
  t3_files_stat: McpToolAccess.reads(({ absolutePath }) =>
    Effect.gen(function* () {
      const files = yield* FilesService.FilesService;
      return yield* files.stat({ absolutePath }).pipe(Effect.mapError(asFailure));
    }),
  ),
  t3_files_read_bytes: McpToolAccess.reads(({ absolutePath, offset, length }) =>
    Effect.gen(function* () {
      const files = yield* FilesService.FilesService;
      return yield* files
        .readBytes({ absolutePath, offset, length })
        .pipe(Effect.mapError(asFailure));
    }),
  ),
  t3_files_locate: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "t3_files_locate");
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const descriptor = yield* environment.getDescriptor;
      const threadId = input.threadId ?? thread.threadId;
      const context = yield* locateContextFor({
        environmentId: descriptor.environmentId,
        threadId,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      });
      const locator = yield* FileLocator;
      const result = yield* locator.locate({ ...input, threadId }, context);
      yield* Effect.logInfo("files.locate", {
        status: result.status,
        via: result.target?.via ?? null,
        candidateCount: result.candidates?.length ?? 0,
        tiers: result.tried.map((entry) => entry.tier),
      });
      return result;
    }),
  ),
});
