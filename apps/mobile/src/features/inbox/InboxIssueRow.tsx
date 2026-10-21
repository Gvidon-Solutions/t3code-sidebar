import type { ScopedInboxIssue } from "@t3tools/client-runtime/inbox";
import { isInboxIssueUnread } from "@t3tools/contracts";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { INBOX_SEVERITY_DOT } from "./inboxList";

export function inboxSourceLabel(item: ScopedInboxIssue): string {
  const { source } = item.issue;
  const kind =
    source.kind === "scheduled_task"
      ? "Scheduled task"
      : source.kind === "client"
        ? "Client"
        : null;
  return kind && !source.label ? kind : source.label;
}

/** One issue card in the Inbox list: a status mark, the title, and a quiet meta line. */
export const InboxIssueRow = memo(function InboxIssueRow(props: {
  readonly item: ScopedInboxIssue;
  readonly onPress: (item: ScopedInboxIssue) => void;
}) {
  const { issue, environmentLabel } = props.item;
  const unread = isInboxIssueUnread(issue);
  const open = issue.state === "open";
  const yourTurn = open && issue.waitingForOwner;
  const time = relativeTime(open ? issue.activityAt : (issue.closedAt ?? issue.updatedAt));
  const meta = [
    environmentLabel,
    inboxSourceLabel(props.item),
    issue.repeatCount > 0 ? `×${issue.repeatCount + 1}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${unread ? "Unread. " : ""}${yourTurn ? "Your turn. " : ""}${issue.title}`}
      onPress={() => props.onPress(props.item)}
      className="mb-2 flex-row gap-3 rounded-[18px] bg-grouped-card px-4 py-3 active:opacity-70"
    >
      <View className="h-[22px] w-3.5 items-center justify-center">
        {open ? (
          <View className={cn("size-2 rounded-full", INBOX_SEVERITY_DOT[issue.severity])} />
        ) : (
          <SymbolView
            name={issue.state === "resolved" ? "checkmark.circle" : "nosign"}
            size={14}
            tintColorClassName={
              issue.state === "resolved"
                ? "accent-adaptive-emerald-600-400"
                : "accent-foreground-tertiary"
            }
            type="monochrome"
          />
        )}
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-start gap-2">
          <Text
            numberOfLines={2}
            className={cn(
              "min-w-0 flex-1 text-base leading-snug",
              !open
                ? "text-foreground-secondary"
                : unread || yourTurn
                  ? "font-t3-medium text-foreground"
                  : "text-foreground",
            )}
          >
            {issue.title}
          </Text>
          <Text className="pt-0.5 text-xs tabular-nums text-foreground-tertiary">{time}</Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground-muted">
            {meta}
          </Text>
          {yourTurn ? (
            <View className="flex-row items-center gap-1">
              <SymbolView
                name="questionmark.bubble"
                size={12}
                tintColorClassName="accent-foreground"
                type="monochrome"
              />
              <Text className="text-xs font-t3-medium text-foreground">Your turn</Text>
            </View>
          ) : unread ? (
            <View className="size-2 rounded-full bg-adaptive-blue-500-400" />
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});
