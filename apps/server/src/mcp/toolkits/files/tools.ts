import { MeshLayoutService } from "../../../mesh/MeshLayoutService.ts";
import { McpDomainAnnotation } from "../../McpToolDomain.ts";
import {
  FILES_LIST_MAX_LIMIT,
  FilesListResult,
  FilesReadResult,
  OrchestratorMcpFailure,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as FilesService from "../../../files/FilesService.ts";

/**
 * T3 Mesh (fork): the tools a connected server calls on the machine that holds
 * a file. Clients reach it through `files.read` / `files.list`; agents read
 * normally through their own machine.
 */
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [MeshLayoutService, FilesService.FilesService],
};

const FilesReadTool = Tool.make("t3_files_read", {
  ...shared,
  description:
    "Read a file on this machine by absolute path (or ~/). Other machines reach it through files.read.",
  parameters: Schema.Struct({
    absolutePath: TrimmedNonEmptyString,
  }),
  success: FilesReadResult,
}).annotate(McpDomainAnnotation, "files");

const FilesListTool = Tool.make("t3_files_list", {
  ...shared,
  description: "List a folder or complete the last segment of an absolute path on this machine.",
  parameters: Schema.Struct({
    partialPath: TrimmedNonEmptyString,
    limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(FILES_LIST_MAX_LIMIT))),
  }),
  success: FilesListResult,
}).annotate(McpDomainAnnotation, "files");

export const FilesToolkit = Toolkit.make(FilesReadTool, FilesListTool);
