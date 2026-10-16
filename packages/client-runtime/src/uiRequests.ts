import type { UiRequest, VoiceCommand } from "@t3tools/contracts";

/**
 * Fork: what this client does with an agent's request to show something.
 * - `navigate`: this client holds the asking thread's voice conversation, so
 *   the owner asked out loud; switch to it at once.
 * - `panel`: this client is showing the asking thread; open the file or diff
 *   in its side panel without leaving.
 * - `navigate` also when this client is showing the asking thread and the
 *   target is elsewhere: the owner is looking at the agent they asked.
 * - `ignore`: the asking thread is not in front of the owner here, so a
 *   background agent never pulls any device away.
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
