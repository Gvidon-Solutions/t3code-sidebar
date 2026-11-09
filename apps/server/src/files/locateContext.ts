import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { LocateContext } from "./FileLocator.ts";

/**
 * The one place the resolver learns the asking thread's directory, project and
 * the files that thread touched. Both `files.locate` and `t3_files_locate` use it,
 * so a tap and an agent's check resolve the same way.
 */
export const locateContextFor = Effect.fn("files.locateContextFor")(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly cwd?: string;
}) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const records =
    input.threadId === undefined
      ? null
      : yield* threads
          .getThreadRecords(input.threadId, ["turnItems"], {
            turnItemTypes: ["file_change", "checkpoint"],
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logDebug("files.locate thread lookup failed", cause).pipe(Effect.as(null)),
            ),
          );
  const touchedPaths = (records?.turnItems ?? []).flatMap((item) =>
    item.type === "file_change"
      ? [item.fileName]
      : item.type === "checkpoint"
        ? item.files.map((file) => file.path)
        : [],
  );
  const project =
    records === null
      ? null
      : yield* projects.getById(records.thread.projectId).pipe(
          Effect.map((value) => (Option.isSome(value) ? value.value : null)),
          Effect.orElseSucceed(() => null),
        );
  const cwd = input.cwd ?? records?.thread.worktreePath ?? project?.workspaceRoot;
  const worktreePath = records?.thread.worktreePath ?? null;
  const context: LocateContext = {
    environmentId: input.environmentId,
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    ...(cwd === undefined || cwd === null ? {} : { cwd }),
    worktreePath,
    ...(project?.workspaceRoot === undefined ? {} : { projectRoot: project.workspaceRoot }),
    ...(project?.title === undefined ? {} : { projectTitle: project.title }),
    touchedPaths,
  };
  return context;
});
