import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, InboxIssueId } from "@t3tools/contracts";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/**
 * Fork: the label over a user-role message the inbox delivered into a
 * thread, an owner comment or a notice. Opens the issue.
 */
export function InboxMessageAttribution(props: {
  readonly environmentId: EnvironmentId;
  readonly inbox: {
    readonly issueId: InboxIssueId;
    readonly title: string;
    readonly kind: "comment" | "notice";
  };
}) {
  const navigation = useNavigation();
  const prefix = props.inbox.kind === "comment" ? "From inbox" : "Inbox notice";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open inbox issue ${props.inbox.title}`}
      hitSlop={4}
      className="max-w-[85%]"
      onPress={() =>
        navigation.navigate("InboxIssue", {
          environmentId: String(props.environmentId),
          issueId: String(props.inbox.issueId),
        })
      }
    >
      <Text
        numberOfLines={1}
        className="mb-1 pr-1 font-t3-medium text-2xs text-foreground-muted opacity-60"
      >
        {prefix} · {props.inbox.title}
      </Text>
    </Pressable>
  );
}
