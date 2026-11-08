import type { ThreadForkOutcome } from "@t3tools/client-runtime/state/thread-forks";

export interface ForkAlert {
  readonly title: string;
  readonly message: string;
}

/**
 * The user-facing message for a fork that did not open. A source that vanished
 * gets the same plain sentence as web; an interrupted fork stays silent.
 */
export function forkOutcomeAlert(outcome: ThreadForkOutcome): ForkAlert | null {
  switch (outcome.kind) {
    case "source-missing":
      return { title: "Could not fork thread", message: "This thread is no longer available." };
    case "failed":
      return { title: "Could not fork thread", message: outcome.message };
    case "created-unavailable":
      return {
        title: "Fork created",
        message:
          "Its thread data did not reach this client. Reconnect and try opening it from the thread list.",
      };
    case "forked":
    case "interrupted":
      return null;
  }
}
