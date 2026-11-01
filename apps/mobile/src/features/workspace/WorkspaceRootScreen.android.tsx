import { useEnabledNavigationTabs } from "./navigation-tabs";
import { NAVIGATION_TAB_ORDER } from "./navigation-tab-order";
import { WorkspaceExtraTab } from "./WorkspaceExtraTab";
import { useMemo } from "react";
import { View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { EmptyState } from "../../components/ui/EmptyState";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { HomeRouteScreen } from "../home/HomeRouteScreen";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceTabPanes } from "./WorkspaceTabPanes";
import type { WorkspaceTab } from "./workspace-tabs-state";

const TABS: readonly WorkspaceTab[] = NAVIGATION_TAB_ORDER;

export function WorkspaceRootScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const workspace = useWorkspaceTabs()!;
  const enabled = useEnabledNavigationTabs();
  const insets = useSafeAreaInsets();
  const { fabClearance } = useAndroidControlSizing();
  const context = useMemo(
    () => ({
      ...workspace,
      bottomClearance: layout.usesSplitView ? workspace.bottomClearance : fabClearance + 16,
    }),
    [workspace, fabClearance, layout.usesSplitView],
  );
  const tab = workspace.state.selectedTab;

  return (
    <WorkspaceTabsContext value={context}>
      <View className={layout.usesSplitView ? "flex-1 bg-screen" : "flex-1 bg-header"}>
        {layout.usesSplitView ? (
          <SafeAreaInsetsContext value={insets}>
            {enabled.length === 0 ? (
              <View className="flex-1 bg-screen" />
            ) : (
              <WorkspaceTabPanes
                tabs={TABS}
                selected={tab}
                renderTab={(tab) =>
                  tab === "threads" ? (
                    <HomeRouteScreen />
                  ) : tab !== "pullRequests" ? (
                    <WorkspaceExtraTab tab={tab} />
                  ) : (
                    <>
                      <NativeStackScreenOptions options={{ headerShown: false }} />
                      <AndroidScreenHeader title="Pull requests" />
                      <View className="flex-1 items-center justify-center px-10">
                        <EmptyState
                          title="Select a pull request"
                          detail="Choose a pull request from the sidebar to review it."
                          variant="plain"
                        />
                      </View>
                    </>
                  )
                }
              />
            )}
          </SafeAreaInsetsContext>
        ) : (
          <>
            <NativeStackScreenOptions options={{ headerShown: false }} />
            <HomeRouteScreen />
          </>
        )}
      </View>
    </WorkspaceTabsContext>
  );
}
