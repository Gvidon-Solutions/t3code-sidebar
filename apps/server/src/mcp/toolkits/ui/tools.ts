import { OrchestratorMcpFailure, UiOpenInput, UiOpenResult } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as UiRequests from "../../../uiRequests/UiRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Fork: agents (and voice conversations) showing things on the owner's screen.
const UiOpenTool = Tool.make("ui_open", {
  description:
    "Show something on the user's screen when they ask to open, show or go to it: a thread, the inbox (or one issue), a file of this thread's workspace (path relative to it, optional line), this thread's diff, a sidebar workspace by name, or the home screen. The device holding a voice conversation in this thread switches to it at once; a device showing this thread opens files and the diff in its side panel and offers a button for the rest. Find thread ids with the thread tools first. Call it right away, then confirm in one short sentence.",
  parameters: UiOpenInput,
  success: UiOpenResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    UiRequests.UiRequests,
  ],
})
  .annotate(Tool.Title, "Open on screen")
  .annotate(Tool.Destructive, false);

export const UiToolkit = Toolkit.make(UiOpenTool);
