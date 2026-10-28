import type { UiRequest, VoiceCommand } from "@t3tools/contracts";

/**
 * Fork: what this client does with an agent's request to show something. `navigate` when it holds
 * the thread's voice conversation, or shows the thread and the target is elsewhere; `panel` when
 * it shows the thread; `ignore` otherwise, so a background agent never pulls a device away.
 */
export type UiRequestDecision = "navigate" | "panel" | "ignore";

export function decideUiRequest(input: {
  readonly request: UiRequest;
  /** The thread whose voice conversation this client holds, if any. */
  readonly voiceThreadId: string | null;
  /** The thread this client is showing, if any. */
  readonly shownThreadId: string | null;
}): UiRequestDecision {
  const { request } = input;
  if (input.voiceThreadId === request.threadId) return "navigate";
  if (input.shownThreadId !== request.threadId) return "ignore";
  return request.target.kind === "file" || request.target.kind === "diff" ? "panel" : "navigate";
}

/**
 * Fork: a spoken command for a voice conversation (`voice_control`,
 * `voice_move`) applies only on the client holding that thread's
 * conversation; every other client ignores it.
 */
export function appliesVoiceCommand(input: {
  readonly command: VoiceCommand;
  /** The thread whose voice conversation this client holds, if any. */
  readonly voiceThreadId: string | null;
}): boolean {
  return input.voiceThreadId !== null && input.voiceThreadId === input.command.threadId;
}
