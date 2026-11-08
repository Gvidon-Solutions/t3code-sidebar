import { McpDomainAnnotation } from "../../McpToolDomain.ts";
import * as Digest from "effect/crypto/Digest";
import {
  OrchestratorMcpEnvironmentTarget,
  ReplicaLiveStatus,
  SidebarProjectMount,
  ScheduledTaskId,
  ScheduledTask,
  OrchestrationSearchThreadsInput,
  OrchestrationThreadSearchMatch,
  OrchestrationV2ThreadForkSourcePoint,
  OrchestrationV2ContextTransfer,
  TrimmedNonEmptyString,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  RuntimeRequestId,
  ProviderUserInputAnswers,
  IsoDateTime,
  OrchestratorMcpFailure,
  OrchestrationV2DispatchCommandResult,
  ThreadId,
  RunId,
  NonNegativeInt,
  ProjectId,
  ThreadMoveResult,
  ThreadForkResult,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ThreadOrganizeTool = Tool.make("t3_thread_organize", {
  description:
    "Move, pin, snooze, settle, archive, or mark a thread unread. Move changes the project on this machine; use t3_thread_fork to continue on another machine. Omit `threadId` for this thread. `snooze` needs `snoozedUntil`. Settling this thread applies at turn end. A failed turn or queued message leaves it active.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals([
      "move",
      "pin",
      "unpin",
      "snooze",
      "unsnooze",
      "settle",
      "unsettle",
      "archive",
      "unarchive",
      "mark_unread",
    ]),
    projectId: Schema.optional(ProjectId),
    snoozedUntil: Schema.optional(IsoDateTime),
  }),
  success: Schema.Union([
    ThreadMoveResult,
    OrchestrationV2DispatchCommandResult,
    Schema.Struct({ settlesWhenTurnEnds: Schema.Literal(true) }),
  ]),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SecureRandom.SecureRandom,
    Digest.Digest,
  ],
})
  .annotate(McpDomainAnnotation, "threads")
  .annotate(Tool.Title, "Organize a thread")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, true);

const commandTool = {
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SecureRandom.SecureRandom,
    Digest.Digest,
  ],
};
const queueEntry = Schema.Struct({
  queuedRunId: RunId,
  text: Schema.String,
  truncated: Schema.Boolean,
});
const QUEUE_READ_ACTIONS = ["list", "read"] as const;
const QueueTool = Tool.make("t3_queue", {
  ...commandTool,
  description:
    "Manage a thread's queued messages. Omit `threadId` for this thread. list: send order, paged by `cursor` and `limit`. read: up to 16,000 chars of one. edit: replace its `text`; attachments stay. cancel. reorder: before `beforeRunId`, or to the end with null. promote_to_steer: send it now as steering to active `targetRunId`. Writes fail once the run is no longer queued.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      ...QUEUE_READ_ACTIONS,
      "edit",
      "cancel",
      "reorder",
      "promote_to_steer",
    ]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    queuedRunId: Schema.optional(RunId),
    text: Schema.optional(Schema.String.check(Schema.isMaxLength(100000))),
    beforeRunId: Schema.optional(Schema.NullOr(RunId)),
    targetRunId: Schema.optional(RunId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Union([
    Schema.Struct({ items: Schema.Array(queueEntry), nextCursor: Schema.NullOr(NonNegativeInt) }),
    queueEntry,
    OrchestrationV2DispatchCommandResult,
  ]),
})
  .annotate(McpDomainAnnotation, "threads")
  .annotate(Tool.Destructive, true);

const question = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      value: Schema.optional(Schema.String),
    }),
  ),
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  initialAnswer: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
});
const PendingRequestTool = Tool.make("t3_pending_request", {
  ...commandTool,
  description:
    "Pending user questions in a thread. Omit `threadId` for this thread. list: their ids; approvals are not listed. read: one by `requestId`. respond: answer one with `answers`; this cannot approve a permission request.",
  parameters: Schema.Struct({
    action: Schema.Literals(["list", "read", "respond"]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    requestId: Schema.optional(RuntimeRequestId),
    answers: Schema.optional(ProviderUserInputAnswers),
  }),
  success: Schema.Union([
    Schema.Struct({ requestIds: Schema.Array(RuntimeRequestId) }),
    Schema.Struct({ requestId: RuntimeRequestId, questions: Schema.Array(question) }),
    OrchestrationV2DispatchCommandResult,
  ]),
})
  .annotate(McpDomainAnnotation, "threads")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const threadConfiguration = Schema.Struct({
  threadId: ThreadId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
const ThreadConfigureTool = Tool.make("t3_thread_configure", {
  ...commandTool,
  description:
    "Read a thread's provider, model, and modes, or set its provider, model, and options with `modelSelection`. Omit `threadId` for this thread. Permission modes stay. Values from `orchestrator_capabilities`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    modelSelection: Schema.optional(ModelSelection),
  }),
  success: Schema.Union([threadConfiguration, OrchestrationV2DispatchCommandResult]),
})
  .annotate(McpDomainAnnotation, "threads")
  .annotate(Tool.Destructive, true);

const ThreadMoveTool = Tool.make("t3_thread_move", {
  ...commandTool,
  description:
    "Move an idle conversation to another project on this machine. No model is needed. projectId is the destination project. modelSelection optionally changes the thread's provider and model.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    projectId: ProjectId,
    modelSelection: Schema.optional(ModelSelection),
  }),
  success: ThreadMoveResult,
})
  .annotate(McpDomainAnnotation, "threads")
  .annotate(Tool.Destructive, true);

const ThreadForkTool = Tool.make("t3_thread_fork", {
  ...commandTool,
  description:
    "Fork an idle or running conversation to another machine as a new thread. Copies the transcript through the last completed turn and its attachments; the original keeps running and is not archived. environmentId selects the machine holding the thread; targetEnvironmentId is the destination machine. projectId or logicalKey picks the destination project representation; omit to use the same logical project. modelSelection chooses the destination harness, model and effort. title and message are optional.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    targetEnvironmentId: Schema.String,
    threadId: Schema.optional(ThreadId),
    projectId: Schema.optional(ProjectId),
    logicalKey: Schema.optional(Schema.String),
    modelSelection: Schema.optional(ModelSelection),
    title: Schema.optional(TrimmedNonEmptyString),
    message: Schema.optional(Schema.String),
    clientRequestId: Schema.optional(Schema.String),
  }),
  success: ThreadForkResult,
})
  .annotate(McpDomainAnnotation, "threads")
  .annotate(Tool.Destructive, true);

const ThreadTransferTool = Tool.make("t3_thread_transfer", {
  ...commandTool,
  description:
    "Move context between threads. Omit `threadId` for this thread. fork: copy it from `sourcePoint` (default latest stable run) into a new thread with the same setup; no turn runs yet. merge_back: merge it from `sourcePoint` into a related `targetThreadId` in the same project. status: its context transfers.",
  parameters: Schema.Struct({
    action: Schema.Literals(["fork", "merge_back", "status"]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    sourcePoint: Schema.optional(OrchestrationV2ThreadForkSourcePoint),
    targetThreadId: Schema.optional(ThreadId),
    title: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Union([
    Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId }),
    Schema.Struct({
      transfers: Schema.Array(
        Schema.Struct({
          id: OrchestrationV2ContextTransfer.fields.id,
          sourceThreadId: OrchestrationV2ContextTransfer.fields.sourceThreadId,
          targetThreadId: OrchestrationV2ContextTransfer.fields.targetThreadId,
          status: OrchestrationV2ContextTransfer.fields.status,
        }),
      ),
    }),
  ]),
})
  .annotate(McpDomainAnnotation, "threads")
  .annotate(Tool.Destructive, true);

const ThreadSearchTool = Tool.make("t3_thread_search", {
  ...commandTool,
  description:
    "Search active threads by title, branch, PR, project, then message text. Skips subagent threads. `projectId`: one project, else yours, else all outside a thread. Not exhaustive.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...OrchestrationSearchThreadsInput.fields,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Struct({
    unreachable: Schema.optional(
      Schema.Array(Schema.Struct({ environmentId: Schema.String, message: Schema.String })),
    ),
    matches: Schema.Array(
      Schema.Struct({
        environmentId: Schema.optional(Schema.String),
        machineTag: Schema.optional(Schema.String),
        threadId: OrchestrationThreadSearchMatch.fields.threadId,
        projectId: OrchestrationThreadSearchMatch.fields.projectId,
        title: Schema.String,
        link: Schema.optional(Schema.String),
        source: Schema.Literals(["title", "user", "assistant"]),
        snippet: Schema.optional(OrchestrationThreadSearchMatch.fields.snippet),
        messageCreatedAt: Schema.optional(OrchestrationThreadSearchMatch.fields.messageCreatedAt),
      }),
    ),
  }),
  dependencies: [...commandTool.dependencies, ThreadSearch.ThreadSearch],
})
  .annotate(McpDomainAnnotation, "threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ScheduledTaskRunTool = Tool.make("run_scheduled_task_now", {
  ...commandTool,
  description:
    "Run one scheduled task now. Needs a full-access or default caller. Returns its thread, or null if not started. Success means started, not finished.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    taskId: ScheduledTaskId,
  }),
  success: Schema.Struct({
    taskId: ScheduledTaskId,
    threadId: ScheduledTask.fields.threadId,
    link: Schema.optional(Schema.String),
    lastRunStatus: ScheduledTask.fields.lastRunStatus,
    runCount: NonNegativeInt,
    nextRunAt: ScheduledTask.fields.nextRunAt,
  }),
  dependencies: [...commandTool.dependencies, ScheduledTaskService.ScheduledTaskService],
})
  .annotate(McpDomainAnnotation, "threads")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const machine = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  tag: Schema.String,
});
const ThreadSelfTool = Tool.make("t3_thread_self", {
  description:
    "Identify this calling thread, machine, project, primary and replica paths, sync state, links and child threads. Read-only; no mesh probes.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    threadId: ThreadId,
    title: Schema.String,
    link: Schema.String,
    machine,
    project: Schema.NullOr(
      Schema.Struct({
        id: ProjectId,
        title: Schema.String,
        logicalKey: Schema.NullOr(Schema.String),
        logicalTitle: Schema.String,
      }),
    ),
    workingDirectory: Schema.NullOr(Schema.String),
    worktreePath: Schema.NullOr(Schema.String),
    branch: Schema.NullOr(Schema.String),
    representation: Schema.Struct({
      role: Schema.Literals(["primary", "replica"]),
      transport: Schema.String,
      source: Schema.NullOr(Schema.Struct({ machine, path: Schema.NullOr(Schema.String) })),
      sync: Schema.NullOr(ReplicaLiveStatus),
    }),
    primaries: Schema.Array(
      Schema.Struct({ machine, path: Schema.String, ssh: Schema.NullOr(Schema.String) }),
    ),
    representations: Schema.Array(SidebarProjectMount),
    linkedMachines: Schema.Array(
      Schema.Struct({
        ...machine.fields,
        status: Schema.String,
        access: Schema.String,
        lastError: Schema.NullOr(Schema.String),
      }),
    ),
    delegatedTasks: Schema.Array(
      Schema.Struct({
        taskId: Schema.String,
        title: Schema.NullOr(Schema.String),
        status: Schema.String,
        threadId: Schema.NullOr(ThreadId),
        environmentId: Schema.String,
      }),
    ),
    parent: Schema.NullOr(
      Schema.Struct({
        threadId: ThreadId,
        environmentId: Schema.String,
        link: Schema.String,
        title: Schema.NullOr(Schema.String),
      }),
    ),
    parentThreadId: Schema.NullOr(ThreadId),
    children: Schema.Array(
      Schema.Struct({ threadId: ThreadId, title: Schema.String, link: Schema.String }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: commandTool.dependencies,
})
  .annotate(McpDomainAnnotation, "threads")
  .annotate(Tool.Readonly, true);

export const ThreadToolkit = Toolkit.make(
  ThreadSelfTool,
  ScheduledTaskRunTool,
  ThreadSearchTool,
  ThreadConfigureTool,
  ThreadTransferTool,
  ThreadMoveTool,
  ThreadForkTool,
  ThreadOrganizeTool,
  PendingRequestTool,
  QueueTool,
);
