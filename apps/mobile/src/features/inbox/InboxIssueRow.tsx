import type { ScopedInboxIssue } from "@t3tools/client-runtime/inbox";
import { isInboxIssueUnread, type InboxSeverity } from "@t3tools/contracts";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";

export const INBOX_SEVERITY_DOT: Record<InboxSeverity, string> = {
  action: "bg-adaptive-rose-500-400",
  attention: "bg-adaptive-amber-700-400",
  info: "bg-adaptive-neutral-400-500",
};

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

/** One issue card in the Inbox list. */
export const InboxIssueRow = memo(function InboxIssueRow(props: {
  readonly item: ScopedInboxIssue;
  readonly onPress: (item: ScopedInboxIssue) => void;
}) {
  const { issue, environmentLabel } = props.item;
  const unread = isInboxIssueUnread(issue);
  const open = issue.state === "open";
  const time = relativeTime(open ? issue.activityAt : (issue.closedAt ?? issue.updatedAt));
  const meta = [environmentLabel, inboxSourceLabel(props.item)].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${unread ? "Unread. " : ""}${issue.title}`}
      onPress={() => props.onPress(props.item)}
      className="mb-2 flex-row gap-3 rounded-[18px] bg-grouped-card px-4 py-3 active:opacity-70"
    >
      <View className={cn("mt-[7px] size-2.5 rounded-full", INBOX_SEVERITY_DOT[issue.severity])} />
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-start gap-2">
          <Text
            numberOfLines={2}
            className={cn(
              "min-w-0 flex-1 text-base leading-snug text-foreground",
              unread ? "font-t3-bold" : "font-t3-medium",
            )}
          >
            {issue.title}
          </Text>
          <View className="flex-row items-center gap-1.5 pt-0.5">
            {unread ? <View className="size-2 rounded-full bg-adaptive-blue-500-400" /> : null}
            <Text className="text-xs tabular-nums text-foreground-tertiary">{time}</Text>
          </View>
        </View>
        {meta ? (
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            {meta}
          </Text>
        ) : null}
        {(open && issue.waitingForOwner) || issue.repeatCount > 0 || !open ? (
          <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
            {open && issue.waitingForOwner ? (
              <Text className="text-xs font-t3-bold text-adaptive-rose-600-400">
                Needs your answer
              </Text>
            ) : null}
            {issue.repeatCount > 0 ? (
              <Text className="text-xs font-t3-medium tabular-nums text-foreground-muted">
                ×{issue.repeatCount}
              </Text>
            ) : null}
            {!open ? (
              <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-muted">
                {issue.state === "resolved" ? "Resolved" : "Closed as not relevant"}
                {issue.closeNote ? `: ${issue.closeNote}` : ""}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
});
