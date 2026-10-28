import { StackActions, useNavigation } from "@react-navigation/native";
import { Alert, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { terminalTabKey } from "../panels/terminalTabs";
import { useThreadPager } from "../panels/threadPagerContext";
import { useThreadTabs } from "./useThreadTabs";

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

/**
 * Thread tabs (sidebar fork): Chat, the thread's live terminals in the pager, then its open files.
 * A tab flips the pager or swaps the file in; a file restores its mode and scroll. Long-press
 * closes a file tab or kills a terminal. Hidden on the chat while nothing is open.
 */
export function ThreadTabStrip(props: {
  readonly environmentId: string;
  readonly threadId: string;
  /** The file (or `terminalTabKey`) shown on this screen; null on the chat. */
  readonly activePath: string | null;
}) {
  const navigation = useNavigation();
  const pager = useThreadPager();
  const threadTabs = useThreadTabs(`${props.environmentId}:${props.threadId}`);
  const terminals = pager?.terminals ?? [];
  if (threadTabs.tabs.length === 0 && terminals.length === 0 && props.activePath === null)
    return null;

  const threadParams = { environmentId: props.environmentId, threadId: props.threadId };
  const openChat = () => {
    if (pager) pager.goTo(null);
    else if (props.activePath !== null)
      navigation.dispatch(StackActions.popTo("Thread", threadParams));
  };
  const openFile = (path: string) => {
    if (path === props.activePath) return;
    if (pager) {
      pager.goTo(path);
      return;
    }
    const params = { ...threadParams, path: path.split("/").filter(Boolean) };
    // Keep the stack at chat + one file, so Chat is always one pop away.
    navigation.dispatch(
      props.activePath === null
        ? StackActions.push("ThreadFile", params)
        : StackActions.replace("ThreadFile", params),
    );
  };
  const closeTerminal = (terminalId: string, label: string) => {
    Alert.alert(`Close ${label}?`, "This ends the shell and anything running in it.", [
      { text: "Cancel", style: "cancel" },
      { text: "Close", style: "destructive", onPress: () => pager?.closeTerminal(terminalId) },
    ]);
  };
  const closeFile = (path: string) => {
    threadTabs.close(path);
    if (path === props.activePath) openChat();
  };

  const chip = (
    key: string,
    label: string,
    active: boolean,
    onPress: () => void,
    onLongPress?: () => void,
  ) => (
    <Pressable
      key={key}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityHint={onLongPress ? "Long-press to close" : undefined}
      onPress={onPress}
      onLongPress={onLongPress}
      className={cn("rounded-full px-3 py-1.5", active ? "bg-primary" : "bg-subtle")}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      testID={`thread-tab-${label}`}
    >
      <Text
        numberOfLines={1}
        className={cn(
          "max-w-[160px] text-xs font-t3-medium",
          active ? "text-primary-foreground" : "text-foreground-secondary",
        )}
      >
        {label}
      </Text>
    </Pressable>
  );

  return (
    <View className="border-b border-border bg-screen" testID="thread-tab-strip">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingVertical: 8 }}
      >
        {chip("chat", "Chat", props.activePath === null, openChat)}
        {terminals.map((terminal) => {
          const key = terminalTabKey(terminal.terminalId);
          return chip(
            key,
            `>_ ${terminal.label}`,
            key === props.activePath,
            () => openFile(key),
            () => closeTerminal(terminal.terminalId, terminal.label),
          );
        })}
        {threadTabs.tabs.map((tab) =>
          chip(
            tab.path,
            basename(tab.path),
            tab.path === props.activePath,
            () => openFile(tab.path),
            () => closeFile(tab.path),
          ),
        )}
      </ScrollView>
    </View>
  );
}
