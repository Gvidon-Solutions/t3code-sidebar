import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { offlineConversationStatus } from "@t3tools/client-runtime/state/mesh-machines";

export interface FloatingStatusAction {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}

export type FloatingWorkingStatus =
  | { readonly kind: "working"; readonly startedAt: string }
  | { readonly kind: "syncing"; readonly label: string }
  | { readonly kind: "compacting" }
  | {
      readonly kind: "child-input";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly onPress: () => void;
    }
  | {
      readonly kind: "background";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly waiting: boolean;
      readonly onPress: () => void;
      readonly action: FloatingStatusAction;
    }
  | {
      readonly kind: "lifecycle";
      readonly state: "snoozed" | "settled" | "woke";
      readonly label: string;
      readonly action: FloatingStatusAction;
    }
  | {
      readonly kind: "stop";
      readonly label: string;
      readonly unresponsive: boolean;
      readonly action: FloatingStatusAction | null;
    }
  | { readonly kind: "goal"; readonly label: string; readonly accessibilityLabel: string }
  | { readonly kind: "preparing"; readonly label: string }
  | {
      readonly kind: "connection";
      readonly tone: "reconnecting" | "unavailable";
      readonly label: string;
      readonly onPress: () => void;
    };

export function connectionFloatingStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly environmentLabel: string | null;
  readonly hasCachedConversation?: boolean;
  /** The reconnect window passed, so a still-retrying connection is offline. */
  readonly reconnectWindowElapsed?: boolean;
  /** The centred conversation pane already names the offline machine. */
  readonly offlinePaneVisible?: boolean;
  readonly onReconnect: () => void;
}): FloatingWorkingStatus | null {
  if (input.offlinePaneVisible === true) return null;
  const environmentLabel = input.environmentLabel ?? "Machine";
  const unavailable = (label: string): FloatingWorkingStatus => ({
    kind: "connection",
    tone: "unavailable",
    label,
    onPress: input.onReconnect,
  });

  switch (input.connectionState) {
    case "connecting":
    case "reconnecting":
      if (input.reconnectWindowElapsed === true) {
        const status = offlineConversationStatus({
          label: environmentLabel,
          reconnecting: false,
          hasCachedConversation: input.hasCachedConversation === true,
        });
        return unavailable(
          input.hasCachedConversation
            ? `${status.title} · showing the last saved conversation`
            : `${status.title} · Retry`,
        );
      }
      return {
        kind: "connection",
        tone: "reconnecting",
        label:
          input.connectionError === null
            ? `Reconnecting to ${environmentLabel}...`
            : `Failed to connect. Retrying ${environmentLabel}...`,
        onPress: input.onReconnect,
      };
    case "offline":
      return unavailable("You are offline");
    case "unsupported":
      return unavailable("Client not supported");
    case "error": {
      const status = offlineConversationStatus({
        label: environmentLabel,
        reconnecting: false,
        hasCachedConversation: input.hasCachedConversation === true,
      });
      return unavailable(
        input.hasCachedConversation
          ? `${status.title} · showing the last saved conversation`
          : `${status.title} · Retry`,
      );
    }
    case "available":
      return unavailable(`${environmentLabel} is not connected`);
    case "connected":
      return null;
  }
}
