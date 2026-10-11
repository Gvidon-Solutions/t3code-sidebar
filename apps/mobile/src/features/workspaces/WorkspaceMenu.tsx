import {
  effectiveDefaultWorkspaceId,
  WORKSPACE_COLORS,
  WORKSPACE_GLYPH_PREFIX,
  workspaceColor,
} from "@t3tools/client-runtime/state/sidebar-workspaces";
import type { SidebarWorkspace, SidebarWorkspacesConfig } from "@t3tools/contracts";
import type { MenuAction, NativeActionEvent } from "@react-native-menu/menu";
import { useSyncExternalStore } from "react";
import { Alert } from "react-native";

import type { useSidebarWorkspaces } from "./useSidebarWorkspaces";

export type WorkspaceEditMode = "name" | "label";

// A rename asked for from a tile or the + tile; the header title picks it up
// once that workspace is the open one.
let editRequest: { readonly workspaceId: string; readonly mode: WorkspaceEditMode } | null = null;
const listeners = new Set<() => void>();

export function requestWorkspaceEdit(workspaceId: string, mode: WorkspaceEditMode) {
  editRequest = { workspaceId, mode };
  for (const listener of listeners) listener();
}

export function clearWorkspaceEditRequest() {
  if (editRequest === null) return;
  editRequest = null;
  for (const listener of listeners) listener();
}

export function useWorkspaceEditRequest() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => editRequest,
  );
}

const GLYPH_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["house", "Home"],
  ["briefcase", "Briefcase"],
  ["building", "Company"],
  ["landmark", "Bank"],
  ["wallet", "Money"],
  ["graduation", "Education"],
  ["book", "Book"],
  ["code", "Code"],
  ["bot", "Bot"],
  ["rocket", "Rocket"],
  ["flask", "Lab"],
  ["users", "Team"],
  ["heart", "Heart"],
  ["star", "Star"],
  ["sparkles", "Sparkles"],
  ["game", "Games"],
];
const COLOR_NAMES = ["Blue", "Coral", "Green", "Violet", "Amber", "Teal", "Rose", "Olive"];

/**
 * A workspace's long-press menu (sidebar fork), as on the desktop: rename,
 * tile icon and colour, order, default, delete.
 */
export function workspaceMenu(
  workspace: SidebarWorkspace,
  config: SidebarWorkspacesConfig,
  workspaces: Pick<ReturnType<typeof useSidebarWorkspaces>, "edit" | "openWorkspace">,
): {
  readonly actions: MenuAction[];
  readonly onPressAction: (event: NativeActionEvent) => void;
} {
  const index = config.workspaces.findIndex((entry) => entry.id === workspace.id);
  const isDefault = effectiveDefaultWorkspaceId(config) === workspace.id;
  const icon = workspace.icon ?? "";
  const color = workspaceColor(workspace);
  const on = (checked: boolean) => (checked ? ("on" as const) : ("off" as const));
  const actions: MenuAction[] = [
    { id: "rename", title: "Rename", image: "square.and.pencil" },
    {
      id: "icon",
      title: "Icon",
      subactions: [
        { id: "icon:label", title: "Letters or emoji…" },
        ...GLYPH_LABELS.map(([key, title]) => ({
          id: `icon:glyph:${key}`,
          title,
          state: on(icon === `${WORKSPACE_GLYPH_PREFIX}${key}`),
        })),
        { id: "icon:reset", title: "First letter of the name", state: on(icon === "") },
      ],
    },
    {
      id: "color",
      title: "Color",
      subactions: WORKSPACE_COLORS.map((candidate, colorIndex) => ({
        id: `color:${candidate}`,
        title: COLOR_NAMES[colorIndex] ?? candidate,
        state: on(color === candidate),
      })),
    },
    {
      id: "move-left",
      title: "Move left",
      image: "arrow.left",
      attributes: { disabled: index <= 0 },
    },
    {
      id: "move-right",
      title: "Move right",
      image: "arrow.right",
      attributes: { disabled: index === config.workspaces.length - 1 },
    },
    { id: "default", title: "Default for new projects", state: on(isDefault) },
    isDefault
      ? {
          id: "delete-blocked",
          title: "Default workspace can't be deleted",
          attributes: { disabled: true },
        }
      : { id: "delete", title: "Delete workspace", attributes: { destructive: true } },
  ];

  const onPressAction = ({ nativeEvent }: NativeActionEvent) => {
    const id = nativeEvent.event;
    const { edit } = workspaces;
    if (id === "rename" || id === "icon:label") {
      workspaces.openWorkspace(workspace.id);
      requestWorkspaceEdit(workspace.id, id === "rename" ? "name" : "label");
    } else if (id.startsWith("icon:glyph:")) {
      edit.update(workspace.id, {
        icon: `${WORKSPACE_GLYPH_PREFIX}${id.slice("icon:glyph:".length)}`,
      });
    } else if (id === "icon:reset") {
      edit.update(workspace.id, { icon: null });
    } else if (id.startsWith("color:")) {
      edit.update(workspace.id, { color: id.slice("color:".length) });
    } else if (id === "move-left" || id === "move-right") {
      edit.move(workspace.id, id === "move-left" ? -1 : 1);
    } else if (id === "default") {
      edit.makeDefault(workspace.id);
    } else if (id === "delete") {
      Alert.alert(
        `Delete workspace "${workspace.name}"?`,
        "Its projects move to the default workspace; no threads are deleted.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => edit.remove(workspace.id) },
        ],
      );
    }
  };
  return { actions, onPressAction };
}
