import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { QueuedMessageIcon } from "../threads/queued-message-icon";

/**
 * The vertical guide that ties a thread's agents to it. Agent rows sit inside
 * the row pressable, 8pt in from the list edge, so they draw it 8pt further left.
 */
export function WorkspaceAgentGuide(props: { readonly inRow?: boolean }) {
  return (
    <View
      className={cn(
        "absolute top-0 bottom-0 w-px bg-border",
        props.inRow ? "left-[27px]" : "left-[35px]",
      )}
    />
  );
}

/**
 * A thread as one line inside a workspace folder, like the desktop sidebar:
 * status glyph, title (with the project for pinned and snoozed rows), time.
 * The row around it (press, long-press menu, swipes) is upstream's.
 */
export function WorkspaceThreadLine(props: {
  readonly thread: EnvironmentThreadShell;
  readonly status: { readonly icon: AppSymbolName; readonly iconTintClassName: string } | null;
  readonly unread: boolean;
  /** Settled history recedes. */
  readonly settled: boolean;
  /** Pinned threads outside the Pinned section keep a pin mark. */
  readonly showPin: boolean;
  readonly projectLabel: string | null;
  readonly timeLabel: string;
  readonly working: boolean;
  readonly hasQueuedMessages: boolean;
  readonly selected: boolean;
  /** An agent under the thread that started it: indented on the guide, a check once done. */
  readonly nested?: boolean;
  /** Holds this device's voice conversation: a wave before the time. */
  readonly voice?: boolean;
}) {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const machineLabel =
    savedConnectionsById[props.thread.environmentId]?.environmentLabel ??
    props.thread.environmentId;
  return (
    <View
      className={cn(
        "min-h-[40px] flex-row items-center gap-2.5 py-2 pr-5",
        props.nested ? "pl-[48px]" : "pl-7",
      )}
    >
      {props.nested ? <WorkspaceAgentGuide inRow /> : null}
      <View className="w-4 items-center">
        {props.status ? (
          <SymbolView
            name={props.status.icon}
            size={14}
            tintColorClassName={props.status.iconTintClassName}
          />
        ) : props.nested ? (
          <SymbolView
            name="checkmark.circle"
            size={13}
            tintColorClassName="accent-foreground-muted"
          />
        ) : null}
      </View>
      <Text
        className={cn(
          "min-w-0 flex-1 text-[15px]",
          props.settled && !props.selected ? "text-foreground-tertiary" : "text-foreground",
          props.unread && "font-t3-medium",
        )}
        numberOfLines={1}
      >
        {props.projectLabel ? (
          <Text className="text-[15px] text-foreground-tertiary">{props.projectLabel} </Text>
        ) : null}
        {props.thread.title}
      </Text>
      {props.hasQueuedMessages ? <QueuedMessageIcon selected={props.selected} /> : null}
      <Text
        accessibilityLabel={`Machine: ${machineLabel}`}
        className="max-w-[90px] rounded bg-subtle px-1.5 py-0.5 text-3xs text-foreground-muted"
        numberOfLines={1}
      >
        {machineLabel}
      </Text>
      {props.showPin ? (
        <SymbolView name="pin" size={11} tintColorClassName="accent-foreground-muted" />
      ) : null}
      {props.voice ? (
        <SymbolView
          accessibilityLabel="Voice conversation"
          name="waveform"
          size={13}
          tintColorClassName="accent-primary"
        />
      ) : null}
      <Text
        className={cn(
          "text-xs tabular-nums",
          props.working ? "text-adaptive-sky-600-400" : "text-foreground-tertiary",
        )}
      >
        {props.timeLabel}
      </Text>
    </View>
  );
}
