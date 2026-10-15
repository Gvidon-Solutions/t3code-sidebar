import {
  InboxAgentCommentInput,
  InboxIssueDetail,
  InboxIssueInput,
  InboxListInput,
  InboxListResult,
  InboxPostInput,
  InboxPostResult,
  InboxResolveInput,
  InboxUpdateInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as InboxService from "../../../inbox/InboxService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Fork: agent inbox. How agents should use these tools is in orchestrationInstructions.ts.
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    InboxService.InboxService,
  ],
};

const InboxPostTool = Tool.make("inbox_post", {
  ...shared,
  description:
    "Raise an issue for the owner in the T3 inbox, or update it: one problem is one issue. Posting again with the same dedupeKey updates the open issue, reopens it if it was resolved, and never duplicates it. The calling thread becomes responsible: the owner's comments arrive there. Use instead of starting a new thread to tell the owner something.",
  parameters: InboxPostInput,
  success: InboxPostResult,
})
  .annotate(Tool.Title, "Post inbox issue")
  .annotate(Tool.Destructive, false);

const InboxGetTool = Tool.make("inbox_get", {
  ...shared,
  description:
    "Read an inbox issue with its whole history: the owner's comments, your comments, updates, reminders and how it was closed.",
  parameters: InboxIssueInput,
  success: InboxIssueDetail,
})
  .annotate(Tool.Title, "Read inbox issue")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const InboxListTool = Tool.make("inbox_list", {
  ...shared,
  description:
    "List inbox issues, newest activity first: open ones by default, or resolved, dismissed or all; optionally by severity or by whether they wait for the owner.",
  parameters: InboxListInput,
  success: InboxListResult,
})
  .annotate(Tool.Title, "List inbox issues")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const InboxCommentTool = Tool.make("inbox_comment", {
  ...shared,
  description:
    "Comment on an inbox issue for the owner: what you understood from their instructions, what you are doing, the result, or what you still need. Set waitingForOwner when their answer is needed, or false once it is not.",
  parameters: InboxAgentCommentInput,
  success: InboxIssueDetail,
})
  .annotate(Tool.Title, "Comment on inbox issue")
  .annotate(Tool.Destructive, false);

const InboxUpdateTool = Tool.make("inbox_update", {
  ...shared,
  description:
    "Keep an inbox issue current: severity, title, description, waitingForOwner, related threads, or hand it to another responsible thread. The owner's comments are never edited.",
  parameters: InboxUpdateInput,
  success: InboxIssueDetail,
})
  .annotate(Tool.Title, "Update inbox issue")
  .annotate(Tool.Destructive, false);

const InboxResolveTool = Tool.make("inbox_resolve", {
  ...shared,
  description:
    "Close an inbox issue once you verified the problem is really gone, with a resolution saying how it was fixed and checked. The owner answering does not close an issue; you do.",
  parameters: InboxResolveInput,
  success: InboxIssueDetail,
})
  .annotate(Tool.Title, "Resolve inbox issue")
  .annotate(Tool.Destructive, false);

export const InboxToolkit = Toolkit.make(
  InboxPostTool,
  InboxGetTool,
  InboxListTool,
  InboxCommentTool,
  InboxUpdateTool,
  InboxResolveTool,
);
