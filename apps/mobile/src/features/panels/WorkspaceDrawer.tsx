import { uuidv4 } from "../../lib/uuid";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useMemo } from "react";
import { FlatList, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { cn } from "../../lib/cn";
import { useNavigationThreadShells, useProjects } from "../../state/entities";
import { useHomeListOptions } from "../home/home-list-options";
import { buildHomeProjectScopes } from "../home/homeThreadList";
import { DONE_STATUS_LABEL, STATUS_LABEL_BY_STATUS } from "../threads/thread-list-v2-items";
import { resolveThreadListV2Status, threadHasUnseenCompletion } from "../threads/threadListV2";
import { useWorkspaceHome } from "../workspaces/useWorkspaceHome";
import { FolderDragHost } from "../workspaces/WorkspaceFolderDrag";
import {
  WorkspaceDock,
  WorkspaceFolderRow,
  WorkspaceAgentsRow,
  WorkspaceMoreRow,
  WorkspaceSectionRow,
  WorkspaceTitle,
} from "../workspaces/WorkspaceChrome";
import type { WorkspaceHomeListItem } from "../workspaces/workspaceNavigator";
import { WorkspaceThreadLine } from "../workspaces/WorkspaceThreadLine";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

const NO_ENVIRONMENTS: ReadonlySet<EnvironmentId> = new Set();
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * The left chat panel (sidebar fork): the open workspace's folders and threads,
 * with the workspace tiles below, as Home shows them. Tapping a thread swaps
 * the chat to it; + in a folder starts a new thread there.
 */
export function WorkspaceDrawer(props: {
  readonly currentThreadKey: string;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const projects = useProjects();
  const threads = useNavigationThreadShells();
  const { options } = useHomeListOptions(NO_ENVIRONMENTS);
  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects,
        environmentId: null,
        projectGroupingMode: options.projectGroupingMode,
      }),
    [options.projectGroupingMode, projects],
  );
  const workspaceHome = useWorkspaceHome({ projectScopes, threads });
  const environmentIds = useMemo(
    () => new Set(threads.map((thread) => thread.environmentId)),
    [threads],
  );
  const { buildItems } = workspaceHome;
  const items = useMemo(() => {
    // oxlint-disable-next-line react/purity -- Snooze state is read when the drawer's list rebuilds; it does not tick.
    const now = new Date().toISOString();
    return buildItems({
      base: [],
      searching: false,
      settlementEnvironmentIds: environmentIds,
      snoozeEnvironmentIds: environmentIds,
      queuedThreadKeys: NO_KEYS,
      selectedThreadKey: props.currentThreadKey,
      toRow: (item) => ({
        type: "v2-thread",
        key: `${item.thread.environmentId}:${item.thread.id}`,
        item,
        snoozeWakeLabelText:
          item.snoozed && item.thread.snoozedUntil != null
            ? snoozeWakeLabel(item.thread.snoozedUntil, { now })
            : undefined,
        timeLabel: "",
        snoozePresetMinute: undefined,
        showTrailingDivider: false,
        hasQueuedMessages: false,
        canMoveUp: false,
        canMoveDown: false,
      }),
    });
  }, [buildItems, environmentIds, props.currentThreadKey]);

  const { onClose } = props;
  const startThread = useCallback(
    (project: EnvironmentProject) => {
      onClose();
      selectDetail({
        name: "Thread",
        params: {
          draft: {
            requestId: uuidv4(),
            environmentId: String(project.environmentId),
            projectId: String(project.id),
            title: project.title,
          },
        },
      });
    },
    [onClose, selectDetail],
  );

  const renderItem = ({ item }: { readonly item: WorkspaceHomeListItem }) => {
    switch (item.type) {
      case "ws-section":
        return <WorkspaceSectionRow item={item} onToggle={workspaceHome.toggle} />;
      case "ws-folder":
        return workspaceHome.config && workspaceHome.currentWorkspaceId ? (
          <WorkspaceFolderRow
            item={item}
            workspaces={workspaceHome.config.workspaces}
            onToggle={workspaceHome.toggle}
            onToggleWorkspace={workspaceHome.toggleProjectIn}
            onFoldMode={workspaceHome.setFoldMode}
            onNewThread={startThread}
          />
        ) : null;
      case "ws-more":
        return (
          <WorkspaceMoreRow item={item} onToggle={workspaceHome.toggle} onNewThread={startThread} />
        );
      case "ws-agents":
        return <WorkspaceAgentsRow item={item} onToggle={workspaceHome.toggle} />;
      case "ws-thread": {
        const thread = item.item.thread;
        const key = `${thread.environmentId}:${thread.id}`;
        const selected = key === props.currentThreadKey;
        const status = resolveThreadListV2Status(thread);
        const unread = status === "ready" && threadHasUnseenCompletion(thread);
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected }}
            className={cn(selected && "bg-subtle")}
            onPress={() => {
              onClose();
              if (selected) return;
              navigation.dispatch(
                StackActions.replace("Thread", {
                  environmentId: String(thread.environmentId),
                  threadId: String(thread.id),
                }),
              );
            }}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <WorkspaceThreadLine
              thread={thread}
              status={STATUS_LABEL_BY_STATUS[status] ?? (unread ? DONE_STATUS_LABEL : null)}
              unread={unread}
              settled={item.item.variant === "slim"}
              showPin={thread.pinnedAt != null && !item.item.pinned}
              projectLabel={item.projectLabel}
              timeLabel={item.timeLabel}
              working={status === "working"}
              hasQueuedMessages={false}
              selected={selected}
              nested={item.nested === true}
              voice={item.voice === true}
            />
          </Pressable>
        );
      }
      default:
        return null;
    }
  };

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
      {workspaceHome.workspace ? <WorkspaceTitle workspace={workspaceHome.workspace} /> : null}
      <FolderDragHost
        getFolders={workspaceHome.arrangeFolders}
        onDrop={workspaceHome.reorderProject}
      >
        <FlatList
          data={items}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: 12 }}
        />
      </FolderDragHost>
      {workspaceHome.config ? (
        <WorkspaceDock
          workspaces={workspaceHome.config.workspaces}
          currentWorkspaceId={workspaceHome.currentWorkspaceId}
          activity={workspaceHome.activity}
          onOpen={workspaceHome.openWorkspace}
          bottomInset={insets.bottom}
          reportsHeight={false}
        />
      ) : null}
    </View>
  );
}
