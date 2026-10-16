import type { UiRequest } from "@t3tools/contracts";

/**
 * Fork: what this client does with an agent's request to show something.
 * - `navigate`: this client holds the asking thread's voice conversation, so
 *   the owner asked out loud; switch to it at once.
 * - `panel`: this client is showing the asking thread; open the file or diff
 *   in its side panel without leaving.
 * - `offer`: this client is showing the asking thread, but the target is
 *   elsewhere; offer a button rather than pulling the owner away.
 * - `ignore`: the asking thread is not in front of the owner here.
 */
export type UiRequestDecision = "navigate" | "panel" | "offer" | "ignore";

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
  return request.target.kind === "file" || request.target.kind === "diff" ? "panel" : "offer";
}

/** A short label for an offered target, e.g. on a "Go there" toast. */
export function describeUiTarget(target: UiRequest["target"]): string {
  switch (target.kind) {
    case "thread":
      return "a thread";
    case "inbox":
      return target.issueId === undefined ? "the inbox" : "an inbox issue";
    case "file":
      return target.path;
    case "diff":
      return "this thread's changes";
    case "workspace":
      return `workspace ${target.workspace}`;
    case "home":
      return "the home screen";
  }
}
