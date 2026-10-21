import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import type { ScopedInboxIssue } from "@t3tools/client-runtime/inbox";
import { useCallback, useMemo, useState } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { Button } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  buildClosedInboxRows,
  buildOpenInboxRows,
  INBOX_CLOSED_PAGE_SIZE,
  INBOX_SEVERITY_LABELS,
  type InboxListRow,
} from "./inboxList";
import { InboxIssueRow } from "./InboxIssueRow";
import { useInboxList } from "./useInbox";

type InboxTab = "open" | "closed";

const TAB_OPTIONS = [
  { value: "open" as const, label: "Open" },
  { value: "closed" as const, label: "Closed" },
];

/** Fork: every connected machine's agent inbox in one list. */
export function InboxRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<InboxTab>("open");
  const [closedLimit, setClosedLimit] = useState(INBOX_CLOSED_PAGE_SIZE);
  const inbox = useInboxList(closedLimit);
  const rows = useMemo(
    () => (tab === "open" ? buildOpenInboxRows(inbox.open) : buildClosedInboxRows(inbox.closed)),
    [inbox.closed, inbox.open, tab],
  );
  const openIssue = useCallback(
    (item: ScopedInboxIssue) =>
      navigation.navigate("InboxIssue", {
        environmentId: String(item.environmentId),
        issueId: String(item.issue.id),
      }),
    [navigation],
  );
  const renderItem = useCallback(
    ({ item }: { item: InboxListRow }) =>
      item.kind === "section" ? (
        <View className="flex-row items-baseline gap-1.5 px-1 pb-2 pt-4">
          <Text className="text-xs font-t3-medium text-foreground-secondary">
            {INBOX_SEVERITY_LABELS[item.severity]}
          </Text>
          <Text className="text-xs tabular-nums text-foreground-tertiary">{item.count}</Text>
        </View>
      ) : (
        <InboxIssueRow item={item.item} onPress={openIssue} />
      ),
    [openIssue],
  );
  const hasMoreClosed = tab === "closed" && inbox.closedTotal > inbox.closed.length;

  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title: "Inbox" }} />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title="Inbox" onBack={() => navigation.goBack()} />
      ) : null}
      <LegendList
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
        }}
        data={rows}
        estimatedItemSize={84}
        getItemType={(item) => item.kind}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        ListHeaderComponent={
          <View className={tab === "closed" ? "pb-3" : undefined}>
            <SegmentedControl options={TAB_OPTIONS} selected={tab} onSelect={setTab} role="tab" />
          </View>
        }
        ListEmptyComponent={
          inbox.isLoading ? (
            <View className="items-center py-16">
              <AppActivityIndicator colorClassName="accent-icon" />
            </View>
          ) : tab === "open" ? (
            <EmptyState
              variant="plain"
              title="All quiet"
              detail="No open issues. Agents will raise anything that needs you here."
            />
          ) : (
            <EmptyState
              variant="plain"
              title="Nothing closed yet"
              detail="Resolved issues and ones you closed as not relevant appear here."
            />
          )
        }
        ListFooterComponent={
          hasMoreClosed ? (
            <View className="items-center pt-2">
              <Button
                label="Show more"
                onPress={() => setClosedLimit((limit) => limit + INBOX_CLOSED_PAGE_SIZE)}
              />
            </View>
          ) : null
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}
