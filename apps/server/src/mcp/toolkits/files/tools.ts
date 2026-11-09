import { MeshLayoutService } from "../../../mesh/MeshLayoutService.ts";
import { McpDomainAnnotation } from "../../McpToolDomain.ts";
import {
  FILES_LIST_MAX_LIMIT,
  FILES_READ_BYTES_MAX,
  FilesListResult,
  FilesLocateInput,
  FilesLocateResult,
  FilesReadBytesResult,
  FilesReadResult,
  FilesStatResult,
  NonNegativeInt,
  OrchestratorMcpFailure,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { FileLocator } from "../../../files/FileLocator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as FilesService from "../../../files/FilesService.ts";

/**
 * T3 Mesh (fork): the tools a connected server calls on the machine that holds
 * a file. Clients reach it through `files.read` / `files.list`; agents read
 * normally through their own machine.
 */
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [MeshLayoutService, FilesService.FilesService, FileLocator],
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

const FilesStatTool = Tool.make("t3_files_stat", {
  ...shared,
  description: "Report whether a path on this machine is a file or folder, its size and mtime.",
  parameters: Schema.Struct({
    absolutePath: TrimmedNonEmptyString,
  }),
  success: FilesStatResult,
}).annotate(McpDomainAnnotation, "files");

const FilesReadBytesTool = Tool.make("t3_files_read_bytes", {
  ...shared,
  description:
    "Read one base64 chunk of a file on this machine. Other machines use it to proxy previews.",
  parameters: Schema.Struct({
    absolutePath: TrimmedNonEmptyString,
    offset: NonNegativeInt,
    length: PositiveInt.check(Schema.isLessThanOrEqualTo(FILES_READ_BYTES_MAX)),
  }),
  success: FilesReadBytesResult,
}).annotate(McpDomainAnnotation, "files");

const FilesLocateTool = Tool.make("t3_files_locate", {
  ...shared,
  dependencies: [
    ...shared.dependencies,
    McpInvocationContext.McpInvocationContext,
    ProjectService.ProjectService,
    ServerEnvironment.ServerEnvironment,
    ThreadManagementService.ThreadManagementService,
  ],
  description:
    "Resolve a path the way a person's tap does: the calling thread's worktree first, then its project, then the primary, then other machines. Returns the machine and absolute path, or why nothing matched. Omit threadId to use the calling thread.",
  parameters: FilesLocateInput,
  success: FilesLocateResult,
}).annotate(McpDomainAnnotation, "files");

export const FilesToolkit = Toolkit.make(
  FilesReadTool,
  FilesListTool,
  FilesStatTool,
  FilesReadBytesTool,
  FilesLocateTool,
);
