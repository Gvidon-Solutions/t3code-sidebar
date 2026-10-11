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
import { workspaceColor, workspaceMark } from "@t3tools/client-runtime/state/sidebar-workspaces";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { SidebarWorkspace } from "@t3tools/contracts";
import type { MenuAction, NativeActionEvent } from "@react-native-menu/menu";
import { memo, useEffect, useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { cn } from "../../lib/cn";
import type {
  WorkspaceFolderListItem,
  WorkspaceMoreListItem,
  WorkspaceSectionListItem,
} from "./workspaceNavigator";
import { setWorkspaceDockHeight } from "./workspaceDockInset";

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
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
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
            <ControlPillMenu
              key={workspace.id}
              actions={menu.actions}
              onPressAction={menu.onPressAction}
              shouldOpenOnLongPress
            >
              {tile}
            </ControlPillMenu>
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
    </View>
  );
}

/** A project folder header, as on the desktop: tap folds it, + starts a thread, long-press moves it. */
export const WorkspaceFolderRow = memo(function WorkspaceFolderRow(props: {
  readonly item: WorkspaceFolderListItem;
  readonly workspaces: ReadonlyArray<SidebarWorkspace>;
  readonly currentWorkspaceId: string;
  readonly onToggle: (key: string) => void;
  readonly onMove: (projectKey: string, workspaceId: string) => void;
  readonly onNewThread: (project: EnvironmentProject) => void;
}) {
  const { item } = props;
  const actions = useMemo(
    () => [
      { id: "new", title: "New thread", image: "square.and.pencil" },
      {
        id: "move",
        title: "Move to workspace",
        subactions: props.workspaces
          .filter((workspace) => workspace.id !== props.currentWorkspaceId)
          .map((workspace) => ({ id: `move:${workspace.id}`, title: workspace.name })),
      },
    ],
    [props.currentWorkspaceId, props.workspaces],
  );
  const handleAction = ({ nativeEvent }: NativeActionEvent) => {
    if (nativeEvent.event === "new") props.onNewThread(item.project);
    else if (nativeEvent.event.startsWith("move:")) {
      props.onMove(item.projectKey, nativeEvent.event.slice("move:".length));
    }
  };
  return (
    <ControlPillMenu actions={actions} onPressAction={handleAction} shouldOpenOnLongPress>
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
        <Text
          className="min-w-0 flex-1 text-[15px] font-t3-medium text-foreground"
          numberOfLines={1}
        >
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
    </ControlPillMenu>
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
