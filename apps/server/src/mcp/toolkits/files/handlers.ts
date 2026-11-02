import { FilesError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { FILES_REASON_PREFIX } from "../../../files/FilesRpc.ts";
import * as FilesService from "../../../files/FilesService.ts";
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
});
