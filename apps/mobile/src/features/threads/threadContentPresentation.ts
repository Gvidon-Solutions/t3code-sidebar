import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { offlineConversationEmptyText } from "@t3tools/client-runtime/state/mesh-machines";

export type ThreadContentPresentation =
  | { readonly kind: "ready" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "unavailable";
      readonly title: string;
      readonly detail: string;
      readonly onRetry?: (() => void) | undefined;
    };

export function projectThreadContentPresentation(input: {
  readonly hasDetail: boolean;
  readonly detailError: string | null;
  readonly detailDeleted: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly machineLabel: string | null;
  readonly reconnectWindowElapsed: boolean;
  readonly onRetry?: (() => void) | undefined;
}): ThreadContentPresentation {
  if (input.hasDetail) {
    return { kind: "ready" };
  }
  if (input.detailDeleted) {
    return {
      kind: "unavailable",
      title: "Thread unavailable",
      detail: "This thread was deleted or is no longer available.",
    };
  }
  if (input.detailError !== null) {
    return {
      kind: "unavailable",
      title: "Could not load conversation",
      detail: input.detailError,
    };
  }
  if (input.connectionState === "connected") {
    return { kind: "loading" };
  }
  const reconnecting =
    input.connectionState === "connecting" || input.connectionState === "reconnecting";
  if (reconnecting && !input.reconnectWindowElapsed) {
    return { kind: "loading" };
  }
  return {
    kind: "unavailable",
    title: `${input.machineLabel ?? "This machine"} is offline`,
    detail: offlineConversationEmptyText(input.machineLabel),
    onRetry: input.onRetry,
  };
}
