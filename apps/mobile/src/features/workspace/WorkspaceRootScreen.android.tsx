import { useMemo } from "react";
import { View } from "react-native";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { EmptyState } from "../../components/ui/EmptyState";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { HomeRouteScreen } from "../home/HomeRouteScreen";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceTabPanes } from "./WorkspaceTabPanes";
import type { WorkspaceTab } from "./workspace-tabs-state";

const TABS: readonly WorkspaceTab[] = ["threads", "pullRequests"];

export function WorkspaceRootScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const workspace = useWorkspaceTabs()!;
  const { fabClearance } = useAndroidControlSizing();
  const context = useMemo(
    () => ({
      ...workspace,
      bottomClearance: fabClearance + 16,
    }),
    [workspace, fabClearance],
  );
  const tab = workspace.state.selectedTab;

  if (layout.usesSplitView) {
    return (
      <WorkspaceTabPanes
        tabs={TABS}
        selected={tab}
        renderTab={(tab) =>
          tab === "threads" ? (
            <HomeRouteScreen />
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
    );
  }

  // Sidebar fork: phones have no Chats / Pull requests bar — the workspace
  // tile bar is the bottom of the screen, and Home is the only root.
  return (
    <WorkspaceTabsContext value={context}>
      <View className="flex-1 bg-header">
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <HomeRouteScreen />
      </View>
    </WorkspaceTabsContext>
  );
}
