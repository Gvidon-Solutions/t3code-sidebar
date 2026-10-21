import type { Icon } from "@tabler/icons-react-native/types";
import IconBook from "@tabler/icons-react-native/IconBook";
import IconBriefcase from "@tabler/icons-react-native/IconBriefcase";
import IconBuilding from "@tabler/icons-react-native/IconBuilding";
import IconBuildingBank from "@tabler/icons-react-native/IconBuildingBank";
import IconCode from "@tabler/icons-react-native/IconCode";
import IconDeviceGamepad from "@tabler/icons-react-native/IconDeviceGamepad";
import IconFlask from "@tabler/icons-react-native/IconFlask";
import IconHeart from "@tabler/icons-react-native/IconHeart";
import IconHome from "@tabler/icons-react-native/IconHome";
import IconRobot from "@tabler/icons-react-native/IconRobot";
import IconRocket from "@tabler/icons-react-native/IconRocket";
import IconSchool from "@tabler/icons-react-native/IconSchool";
import IconSparkles from "@tabler/icons-react-native/IconSparkles";
import IconStar from "@tabler/icons-react-native/IconStar";
import IconUsers from "@tabler/icons-react-native/IconUsers";
import IconWallet from "@tabler/icons-react-native/IconWallet";
import {
  workspaceColor,
  workspaceMark,
  type ProjectFoldMode,
} from "@t3tools/client-runtime/state/sidebar-workspaces";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { SidebarWorkspace } from "@t3tools/contracts";
import type { MenuAction, NativeActionEvent } from "@react-native-menu/menu";
import * as Haptics from "expo-haptics";
import { memo, useEffect, useEffectEvent, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { Menu } from "../../components/ui/Menu";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { cn } from "../../lib/cn";
import type {
  WorkspaceAgentsListItem,
  WorkspaceFolderListItem,
  WorkspaceMoreListItem,
  WorkspaceSectionListItem,
} from "./workspaceNavigator";
import { setWorkspaceDockHeight } from "./workspaceDockInset";
import { FolderDragHandle, useFolderDragAvailable } from "./WorkspaceFolderDrag";
import { WorkspaceAgentGuide } from "./WorkspaceThreadLine";

/** Same glyph keys as the desktop tile icons (`glyph:<key>` in the shared config). */
const WORKSPACE_GLYPHS: Readonly<Record<string, Icon>> = {
  house: IconHome,
  briefcase: IconBriefcase,
  building: IconBuilding,
  landmark: IconBuildingBank,
  wallet: IconWallet,
  graduation: IconSchool,
  book: IconBook,
  code: IconCode,
  bot: IconRobot,
  rocket: IconRocket,
  flask: IconFlask,
  users: IconUsers,
  heart: IconHeart,
  star: IconStar,
  sparkles: IconSparkles,
  game: IconDeviceGamepad,
};

export interface WorkspaceTileActivity {
  readonly attention: number;
  readonly working: number;
}

/** The tile face: a built-in glyph, the custom label or the first letter. */
export function WorkspaceAvatar(props: {
  readonly workspace: SidebarWorkspace;
  readonly size: number;
  readonly selected: boolean;
}) {
  const color = workspaceColor(props.workspace);
  const mark = workspaceMark(props.workspace);
  const GlyphIcon = mark.kind === "glyph" ? WORKSPACE_GLYPHS[mark.glyph] : undefined;
  const foreground = props.selected ? "#ffffff" : color;
  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        borderRadius: props.size * 0.28,
        backgroundColor: props.selected ? color : `${color}26`,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {GlyphIcon ? (
        <GlyphIcon size={props.size * 0.5} color={foreground} strokeWidth={2} />
      ) : (
        <Text
          className="font-t3-bold"
          style={{
            color: foreground,
            fontSize:
              mark.kind === "text" && [...mark.text].length > 1
                ? props.size * 0.34
                : props.size * 0.42,
          }}
        >
          {mark.kind === "text" ? mark.text : "?"}
        </Text>
      )}
    </View>
  );
}

/** Workspace name over the list, as the desktop titlebar shows it. */
export function WorkspaceTitle(props: { readonly workspace: SidebarWorkspace }) {
  return (
    <View className="flex-row items-center gap-3 px-5 pb-2 pt-4">
      <WorkspaceAvatar workspace={props.workspace} size={28} selected />
      <Text className="flex-1 text-lg font-t3-bold text-foreground" numberOfLines={1}>
        {props.workspace.name}
      </Text>
    </View>
  );
}

/**
 * Square workspace tiles along the bottom; a dot marks threads that need you.
 * With `menuFor` a long press opens the workspace menu, and `onAdd` adds a +
 * tile at the end.
 */
export function WorkspaceDock(props: {
  readonly workspaces: ReadonlyArray<SidebarWorkspace>;
  readonly currentWorkspaceId: string | null;
  readonly activity: ReadonlyMap<string, WorkspaceTileActivity>;
  readonly onOpen: (workspaceId: string) => void;
  readonly menuFor?: (workspace: SidebarWorkspace) => {
    readonly actions: MenuAction[];
    readonly onPressAction: (event: NativeActionEvent) => void;
  };
  readonly onAdd?: () => void;
  readonly bottomInset: number;
  /** Home's dock tells the floating buttons to hide; the chat panel's does not. */
  readonly reportsHeight?: boolean;
}) {
  const reportsHeight = props.reportsHeight !== false;
  useEffect(() => (reportsHeight ? () => setWorkspaceDockHeight(0) : undefined), [reportsHeight]);
  // A horizontal swipe along the bar opens the neighbouring workspace. Only
  // while the tiles fit: once the bar scrolls, the swipe belongs to it.
  const [barWidth, setBarWidth] = useState(0);
  const [tilesWidth, setTilesWidth] = useState(0);
  const tilesFit = barWidth > 0 && tilesWidth <= barWidth;
  // The pan callback fires outside render, so an effect event reads the latest props.
  const openNeighbour = useEffectEvent((translationX: number) => {
    const { workspaces, currentWorkspaceId, onOpen } = props;
    const index = workspaces.findIndex((workspace) => workspace.id === currentWorkspaceId);
    const next = workspaces[index + (translationX < 0 ? 1 : -1)];
    if (index < 0 || !next) return;
    void Haptics.selectionAsync();
    onOpen(next.id);
  });
  const swipe = Gesture.Pan()
    .enabled(tilesFit)
    .activeOffsetX([-16, 16])
    .failOffsetY([-14, 14])
    .runOnJS(true)
    .onEnd((event) => {
      if (Math.abs(event.translationX) < 40 && Math.abs(event.velocityX) < 500) return;
      openNeighbour(event.translationX);
    });
  return (
    <View
      className="border-t border-border bg-screen"
      onLayout={
        reportsHeight
          ? (event) => setWorkspaceDockHeight(event.nativeEvent.layout.height)
          : undefined
      }
      style={{ paddingBottom: props.bottomInset }}
      testID="workspace-dock"
    >
      <GestureDetector gesture={swipe}>
        <ScrollView
          horizontal
          // A bar with nothing to scroll would still claim horizontal drags.
          scrollEnabled={!tilesFit}
          showsHorizontalScrollIndicator={false}
          onLayout={(event) => setBarWidth(event.nativeEvent.layout.width)}
          onContentSizeChange={(width) => setTilesWidth(width)}
          contentContainerStyle={{
            gap: 10,
            paddingLeft: 16,
            paddingRight: 16,
            paddingVertical: 10,
          }}
        >
          {props.workspaces.map((workspace) => {
            const selected = workspace.id === props.currentWorkspaceId;
            const activity = props.activity.get(workspace.id);
            const tile = (
              <Pressable
                key={workspace.id}
                accessibilityLabel={`Workspace ${workspace.name}`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => props.onOpen(workspace.id)}
                style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                testID={`workspace-tile-${workspace.id}`}
              >
                <WorkspaceAvatar workspace={workspace} size={40} selected={selected} />
                {activity && (activity.attention > 0 || activity.working > 0) ? (
                  <View
                    className={cn(
                      "absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-screen",
                      activity.attention > 0 ? "bg-warning" : "bg-primary",
                    )}
                  />
                ) : null}
              </Pressable>
            );
            const menu = props.menuFor?.(workspace);
            return menu ? (
              <Menu
                key={workspace.id}
                actions={menu.actions}
                onPressAction={menu.onPressAction}
                shouldOpenOnLongPress
              >
                {tile}
              </Menu>
            ) : (
              tile
            );
          })}
          {props.onAdd ? (
            <Pressable
              accessibilityLabel="New workspace"
              accessibilityRole="button"
              onPress={props.onAdd}
              className="items-center justify-center border border-dashed border-border"
              style={({ pressed }) => ({
                width: 40,
                height: 40,
                borderRadius: 40 * 0.28,
                opacity: pressed ? 0.6 : 1,
              })}
              testID="workspace-tile-new"
            >
              <SymbolView
                name="plus"
                size={18}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
              />
            </Pressable>
          ) : null}
        </ScrollView>
      </GestureDetector>
    </View>
  );
}

/**
 * A project folder header, as on the desktop: tap folds it, + starts a thread.
 * Long-press opens its menu, where "Show in workspaces" picks every workspace
 * the project shows in; on Android, holding and moving drags it into a new
 * place (see `WorkspaceFolderDrag`). "No project" always sits last, so it
 * can't be dragged.
 */
export const WorkspaceFolderRow = memo(function WorkspaceFolderRow(props: {
  readonly item: WorkspaceFolderListItem;
  readonly workspaces: ReadonlyArray<SidebarWorkspace>;
  readonly onToggle: (key: string) => void;
  /** Ticks or unticks one workspace in "Show in workspaces". */
  readonly onToggleWorkspace: (projectKey: string, workspaceId: string) => void;
  /** Moves the project into "Quiet projects" or out of it, or back to folding by itself. */
  readonly onFoldMode: (projectKey: string, mode: ProjectFoldMode) => void;
  readonly onNewThread: (project: EnvironmentProject) => void;
}) {
  const { item } = props;
  const actions = useMemo((): MenuAction[] => {
    const shownIn = item.workspaceIds;
    return [
      { id: "new", title: "New thread", image: "square.and.pencil" },
      {
        id: "show-in",
        title: "Show in workspaces",
        // The last workspace can't be unticked: a project always shows somewhere.
        subactions: props.workspaces.map((workspace) => ({
          id: `show:${workspace.id}`,
          title: workspace.name,
          state: shownIn.includes(workspace.id) ? ("on" as const) : ("off" as const),
          attributes: { disabled: shownIn.length === 1 && shownIn[0] === workspace.id },
        })),
      },
      // "No project" is never quiet.
      ...(item.isScratch
        ? []
        : [
            item.quiet
              ? { id: "fold:active", title: "Move to active projects", image: "sun.max" }
              : { id: "fold:quiet", title: "Move to quiet projects", image: "moon" },
            ...(item.foldMode === "auto"
              ? []
              : [{ id: "fold:auto", title: "Fold automatically", image: "wand.and.stars" }]),
          ]),
    ];
  }, [item.foldMode, item.isScratch, item.quiet, item.workspaceIds, props.workspaces]);
  const handleAction = ({ nativeEvent }: NativeActionEvent) => {
    if (nativeEvent.event === "new") props.onNewThread(item.project);
    else if (nativeEvent.event.startsWith("show:")) {
      props.onToggleWorkspace(item.projectKey, nativeEvent.event.slice("show:".length));
    } else if (nativeEvent.event.startsWith("fold:")) {
      props.onFoldMode(item.projectKey, nativeEvent.event.slice("fold:".length) as ProjectFoldMode);
    }
  };
  const draggable = useFolderDragAvailable() && Platform.OS === "android" && !item.isScratch;
  const row = (
    <Pressable
      accessibilityLabel={item.title}
      accessibilityRole="button"
      accessibilityState={{ expanded: item.open }}
      className="mt-1 flex-row items-center gap-2 py-1 pl-3 pr-2"
      onPress={() => props.onToggle(item.folderKey)}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      testID={`workspace-folder-${item.projectKey}`}
    >
      <SymbolView
        name={item.open ? "chevron.down" : "chevron.right"}
        size={12}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      <ProjectFavicon
        environmentId={item.project.environmentId}
        faviconPath={item.project.faviconPath}
        projectIcon={item.project.projectIcon}
        size={16}
        projectTitle={item.project.title}
        workspaceRoot={item.project.workspaceRoot}
      />
      <Text className="min-w-0 flex-1 text-[15px] font-t3-medium text-foreground" numberOfLines={1}>
        {item.title}
      </Text>
      {!item.open && item.attention > 0 ? (
        <Text className="text-xs font-t3-bold tabular-nums text-warning-foreground">
          ◆{item.attention}
        </Text>
      ) : null}
      {!item.open && item.working > 0 ? (
        <Text className="text-xs font-t3-bold tabular-nums text-adaptive-sky-600-400">
          ●{item.working}
        </Text>
      ) : null}
      <Pressable
        accessibilityLabel={`New thread in ${item.title}`}
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => props.onNewThread(item.project)}
        className="h-8 w-8 items-center justify-center rounded-full"
        style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        testID={`workspace-folder-new-${item.projectKey}`}
      >
        <SymbolView
          name="square.and.pencil"
          size={16}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
      </Pressable>
    </Pressable>
  );
  if (draggable) {
    return (
      <AndroidAnchoredMenu actions={actions} onPressAction={handleAction}>
        {(open) => (
          <FolderDragHandle projectKey={item.projectKey} onMenu={open}>
            {row}
          </FolderDragHandle>
        )}
      </AndroidAnchoredMenu>
    );
  }
  return (
    <Menu actions={actions} onPressAction={handleAction} shouldOpenOnLongPress>
      {row}
    </Menu>
  );
});

const SECTION_LABEL: Record<WorkspaceSectionListItem["kind"], string> = {
  pinned: "Pinned",
  quiet: "Quiet projects",
  snoozed: "Snoozed",
};
const SECTION_ICON = { pinned: "pin", quiet: "moon", snoozed: "clock" } as const;

/** Pinned / Quiet projects / Snoozed headers. */
export const WorkspaceSectionRow = memo(function WorkspaceSectionRow(props: {
  readonly item: WorkspaceSectionListItem;
  readonly onToggle: (key: string) => void;
}) {
  const { item } = props;
  const toggleKey = item.toggleKey;
  return (
    <Pressable
      accessibilityRole={toggleKey ? "button" : "header"}
      accessibilityState={toggleKey ? { expanded: item.open } : undefined}
      className="mt-3 flex-row items-center gap-2 py-1.5 pl-3 pr-5"
      disabled={toggleKey === null}
      onPress={() => (toggleKey ? props.onToggle(toggleKey) : undefined)}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      testID={`workspace-section-${item.kind}`}
    >
      {toggleKey ? (
        <SymbolView
          name={item.open ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
      ) : null}
      <SymbolView
        name={SECTION_ICON[item.kind]}
        size={13}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      <Text className="text-xs font-t3-bold uppercase tracking-wide text-foreground-tertiary">
        {SECTION_LABEL[item.kind]}
      </Text>
      {toggleKey ? (
        <Text className="text-xs tabular-nums text-foreground-tertiary">{item.count}</Text>
      ) : null}
    </Pressable>
  );
});

const AGENT_DOT_CLASS = {
  working: "bg-adaptive-sky-600-400",
  attention: "bg-warning",
  failed: "bg-danger",
  done: "bg-adaptive-emerald-600-400",
} as const;

const MAX_AGENT_DOTS = 8;

/**
 * "5 agents · 4 working" under a thread that launched subagents, with a dot
 * per agent; tapping it shows or hides the agents' rows.
 */
export const WorkspaceAgentsRow = memo(function WorkspaceAgentsRow(props: {
  readonly item: WorkspaceAgentsListItem;
  readonly onToggle: (key: string) => void;
}) {
  const { item } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.label}
      accessibilityState={{ expanded: item.open }}
      className="min-h-[32px] flex-row items-center gap-2 py-1.5 pl-[48px] pr-5"
      onPress={() => props.onToggle(item.toggleKey)}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <WorkspaceAgentGuide />
      <SymbolView
        name={item.open ? "chevron.down" : "chevron.right"}
        size={11}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      <Text className="min-w-0 flex-1 text-[13px] text-foreground-tertiary" numberOfLines={1}>
        {item.label}
      </Text>
      <View className="flex-row items-center gap-1">
        {item.dots.slice(0, MAX_AGENT_DOTS).map((dot) => (
          <View key={dot.key} className={cn("size-1.5 rounded-full", AGENT_DOT_CLASS[dot.state])} />
        ))}
      </View>
    </Pressable>
  );
});

/** "Show N more", "N settled", or New thread in an empty folder. */
export const WorkspaceMoreRow = memo(function WorkspaceMoreRow(props: {
  readonly item: WorkspaceMoreListItem;
  readonly onToggle: (key: string) => void;
  readonly onNewThread: (project: EnvironmentProject) => void;
}) {
  const { item } = props;
  const newThreadIn = item.newThreadIn;
  return (
    <Pressable
      accessibilityRole="button"
      className="flex-row items-center gap-2 py-2 pl-[52px] pr-5"
      onPress={() =>
        newThreadIn ? props.onNewThread(newThreadIn) : props.onToggle(item.toggleKey)
      }
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {newThreadIn ? (
        <SymbolView
          name="square.and.pencil"
          size={12}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
      ) : null}
      <Text className="text-[13px] text-foreground-tertiary">{item.label}</Text>
    </Pressable>
  );
});
