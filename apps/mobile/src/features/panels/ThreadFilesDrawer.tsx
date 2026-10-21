import { StackActions, useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { useThreadTabs } from "../tabs/useThreadTabs";
import { useThreadPager } from "./threadPagerContext";

const splitPath = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { name: path, dir: "" }
    : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
};

function SectionTitle(props: { readonly children: string }) {
  return (
    <Text className="px-5 pb-1 pt-4 text-xs font-t3-bold uppercase tracking-wide text-foreground-tertiary">
      {props.children}
    </Text>
  );
}

function FileRow(props: {
  readonly path: string;
  readonly trailing?: ReactNode;
  readonly onPress: () => void;
  readonly onLongPress?: () => void;
}) {
  const { name, dir } = splitPath(props.path);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={props.onLongPress ? "Long-press to close the tab" : undefined}
      className="flex-row items-center gap-3 px-5 py-2"
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <SymbolView name="doc.text" size={15} tintColorClassName="accent-foreground-muted" />
      <View className="min-w-0 flex-1">
        <Text className="text-[15px] text-foreground" numberOfLines={1}>
          {name}
        </Text>
        {dir ? (
          <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
            {dir}
          </Text>
        ) : null}
      </View>
      {props.trailing}
    </Pressable>
  );
}

function LinkRow(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className="flex-row items-center gap-3 px-5 py-3"
      onPress={props.onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <SymbolView name={props.icon} size={16} tintColorClassName="accent-foreground-muted" />
      <Text className="flex-1 text-[15px] text-foreground">{props.label}</Text>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-foreground-muted" />
    </Pressable>
  );
}

/**
 * The Files panel past the last thread tab (sidebar fork): the thread's open
 * file tabs, the files changed in its working tree, and the way into all files
 * and git.
 */
export function ThreadFilesDrawer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly cwd: string | null;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const pager = useThreadPager();
  const threadParams = { environmentId: String(props.environmentId), threadId: props.threadId };
  const threadTabs = useThreadTabs(`${threadParams.environmentId}:${threadParams.threadId}`);
  const status = useEnvironmentQuery(
    props.cwd !== null
      ? vcsEnvironment.status({ environmentId: props.environmentId, input: { cwd: props.cwd } })
      : null,
  );
  const changed = status.data?.workingTree.files ?? [];

  const openFile = (path: string) => {
    props.onClose();
    if (pager) {
      pager.goTo(path);
      return;
    }
    navigation.dispatch(
      StackActions.push("ThreadFile", {
        ...threadParams,
        path: path.split("/").filter(Boolean),
      }),
    );
  };

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
      <Text className="px-5 pb-1 pt-4 text-lg font-t3-bold text-foreground">Files</Text>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
        {threadTabs.tabs.length > 0 ? <SectionTitle>Open</SectionTitle> : null}
        {threadTabs.tabs.map((tab) => (
          <FileRow
            key={`tab:${tab.path}`}
            path={tab.path}
            onPress={() => openFile(tab.path)}
            onLongPress={() => threadTabs.close(tab.path)}
          />
        ))}
        {changed.length > 0 ? <SectionTitle>{`Changes (${changed.length})`}</SectionTitle> : null}
        {changed.map((file) => (
          <FileRow
            key={`change:${file.path}`}
            path={file.path}
            onPress={() => openFile(file.path)}
            trailing={
              <Text className="text-xs tabular-nums">
                <Text className="text-xs text-adaptive-emerald-700-300">+{file.insertions}</Text>{" "}
                <Text className="text-xs text-adaptive-rose-600-400">−{file.deletions}</Text>
              </Text>
            }
          />
        ))}
        {threadTabs.tabs.length === 0 && changed.length === 0 ? (
          <Text className="px-5 py-3 text-sm text-foreground-tertiary">
            No open tabs or uncommitted changes.
          </Text>
        ) : null}
        <View className="mt-3 border-t border-border" />
        <LinkRow
          icon="folder"
          label="All files"
          onPress={() => {
            props.onClose();
            navigation.navigate("ThreadFiles", threadParams);
          }}
        />
        <LinkRow
          icon="arrow.triangle.branch"
          label="Git"
          onPress={() => {
            props.onClose();
            navigation.navigate("GitOverview", threadParams);
          }}
        />
      </ScrollView>
    </View>
  );
}
