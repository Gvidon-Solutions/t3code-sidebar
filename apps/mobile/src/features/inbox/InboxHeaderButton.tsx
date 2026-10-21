import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useInboxCounts } from "./useInbox";

function CountBadge(props: { readonly count: number; readonly className: string }) {
  if (props.count === 0) return null;
  return (
    <View
      pointerEvents="none"
      className={cn(
        "absolute h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-header px-1",
        props.className,
      )}
    >
      <Text
        allowFontScaling={false}
        className="text-[10px] font-t3-bold leading-[12px] text-white tabular-nums"
      >
        {props.count > 99 ? "99+" : props.count}
      </Text>
    </View>
  );
}

/**
 * Fork: the inbox icon in the home toolbar. Blue counts issues with unseen
 * news, red counts open issues waiting for the owner's answer.
 */
export function InboxHeaderButton() {
  const navigation = useNavigation();
  const { unread, waiting } = useInboxCounts();
  const label = [
    "Inbox",
    unread > 0 ? `${unread} unread` : null,
    waiting > 0 ? `${waiting} waiting for your answer` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <View>
      <AndroidHeaderIconButton
        accessibilityLabel={label}
        icon="tray"
        onPress={() => navigation.navigate("Inbox")}
      />
      <CountBadge count={unread} className="right-0.5 top-0.5 bg-adaptive-blue-500-400" />
      <CountBadge count={waiting} className="bottom-0.5 right-0.5 bg-adaptive-rose-500-400" />
    </View>
  );
}
