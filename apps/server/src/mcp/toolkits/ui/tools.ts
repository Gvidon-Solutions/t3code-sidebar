import {
  OrchestratorMcpFailure,
  UiOpenInput,
  UiOpenResult,
  VoiceCommandResult,
  VoiceControlInput,
  VoiceMoveInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as VoiceSessionService from "../../../orchestration-v2/VoiceSessionService.ts";
import * as UiRequests from "../../../uiRequests/UiRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Fork: agents (and voice conversations) showing things on the owner's screen.
const UiOpenTool = Tool.make("ui_open", {
  description:
    "Show something on the user's screen when they ask to open, show or go to it: a thread, the inbox (or one issue), a file of this thread's workspace (path relative to it, optional line), this thread's diff, a sidebar workspace by name, or the home screen. The device holding a voice conversation in this thread switches to it at once; a device showing this thread opens files and the diff in its side panel and switches to the rest. Find thread ids with the thread tools first. Call it right away, then confirm in one short sentence.",
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

const voiceDependencies = () => [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  UiRequests.UiRequests,
  VoiceSessionService.VoiceSessionServiceV2,
];

// Fork: the owner steering this thread's voice conversation out loud.
const VoiceControlTool = Tool.make("voice_control", {
  description:
    'Control this thread\'s live voice conversation when the owner asks out loud: action "end" hangs up the call, "mute" turns the microphone off and keeps the call open (only the owner can turn it back on, with the microphone button). It acts on the device actually holding the call; the thread, its history and the server stay as they are. Only for a clear request: on a vague "ok, bye" ask first. Confirm in a few words before calling "end", since nothing more is heard after it.',
  parameters: VoiceControlInput,
  success: VoiceCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: voiceDependencies(),
})
  .annotate(Tool.Title, "Control voice conversation")
  .annotate(Tool.Destructive, false);

const VoiceMoveTool = Tool.make("voice_move", {
  description:
    "Move this thread's live voice conversation to another thread when the owner asks to continue it there. The device holding the call hangs up here, opens the target thread and calls again there; the new call starts knowing what was said here. Prepare the target first: t3_thread_fork to carry this thread's work along, or t3_thread_launch for a fresh thread or another project (omit message for an idle thread; put a short brief in message only if the agent there should start working). A thread still preparing is waited for. Say one short sentence before calling it.",
  parameters: VoiceMoveInput,
  success: VoiceCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: voiceDependencies(),
})
  .annotate(Tool.Title, "Move voice conversation")
  .annotate(Tool.Destructive, false);

export const UiToolkit = Toolkit.make(UiOpenTool, VoiceControlTool, VoiceMoveTool);
