import { normalizeWorkspaceLabel } from "@t3tools/client-runtime/state/sidebar-workspaces";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { Keyboard, Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { Menu } from "../../components/ui/Menu";
import { useSidebarWorkspaces } from "./useSidebarWorkspaces";
import { WorkspaceAvatar } from "./WorkspaceChrome";
import {
  clearWorkspaceEditRequest,
  useWorkspaceEditRequest,
  workspaceMenu,
  type WorkspaceEditMode,
} from "./WorkspaceMenu";

/**
 * Home's title (sidebar fork): the open workspace's tile and name in place of
 * the brand. A tap renames it in place, a long press opens the workspace menu.
 * Without workspaces the brand (`fallback`) stays.
 */
export function WorkspaceHeaderTitle(props: { readonly fallback: ReactNode }) {
  const workspaces = useSidebarWorkspaces();
  const { config, currentWorkspaceId, edit } = workspaces;
  const workspace = config?.workspaces.find((entry) => entry.id === currentWorkspaceId) ?? null;
  const { scale } = useAndroidControlSizing();
  const [editing, setEditing] = useState<WorkspaceEditMode | null>(null);
  const [draft, setDraft] = useState("");
  // Mirrors `editing` for `commit`: submit and the blur after it land before a re-render.
  const editingRef = useRef(editing);
  const startEdit = (mode: WorkspaceEditMode) => {
    if (workspace === null) return;
    setDraft(mode === "name" ? workspace.name : (workspace.icon ?? ""));
    editingRef.current = mode;
    setEditing(mode);
  };
  const request = useWorkspaceEditRequest();
  useEffect(() => {
    if (request === null || workspace === null || request.workspaceId !== workspace.id) return;
    clearWorkspaceEditRequest();
    setDraft(request.mode === "name" ? workspace.name : (workspace.icon ?? ""));
    editingRef.current = request.mode;
    setEditing(request.mode);
  }, [request, workspace]);

  // Submit and the blur that follows it both land here; only the first counts.
  const commit = () => {
    const mode = editingRef.current;
    if (mode === null) return;
    editingRef.current = null;
    setEditing(null);
    if (workspace === null) return;
    if (mode === "name") {
      const name = draft.trim();
      if (name.length > 0 && name !== workspace.name) edit.update(workspace.id, { name });
    } else {
      edit.update(workspace.id, { icon: normalizeWorkspaceLabel(draft) });
    }
  };

  // Android's Back hides the keyboard without blurring the field; that ends the edit too.
  const commitOnKeyboardHide = useEffectEvent(commit);
  useEffect(() => {
    if (editing === null) return;
    const subscription = Keyboard.addListener("keyboardDidHide", () => commitOnKeyboardHide());
    return () => subscription.remove();
  }, [editing]);

  if (config === null || workspace === null) return <>{props.fallback}</>;

  const menu = workspaceMenu(workspace, config, workspaces);
  const fontSize = 21 * scale;

  return (
    <View className="min-w-0 flex-1 flex-row items-center" style={{ gap: 10 * scale }}>
      <WorkspaceAvatar workspace={workspace} size={Math.round(28 * scale)} selected />
      {editing !== null ? (
        <TextInput
          accessibilityLabel={editing === "name" ? "Workspace name" : "Tile letters or emoji"}
          autoFocus
          selectTextOnFocus
          returnKeyType="done"
          placeholder={editing === "name" ? "Workspace name" : "Letters or emoji"}
          placeholderTextColorClassName="accent-placeholder"
          selectionColorClassName="accent-focus/32"
          cursorColorClassName="accent-focus"
          selectionHandleColorClassName="accent-focus"
          className="min-w-0 flex-1 font-t3-bold text-foreground"
          style={{ fontSize, paddingVertical: 0 }}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={commit}
          onBlur={commit}
          testID="workspace-title-input"
        />
      ) : (
        <Menu
          actions={menu.actions}
          onPressAction={menu.onPressAction}
          shouldOpenOnLongPress
          className="min-w-0 flex-1"
        >
          <Pressable
            accessibilityHint="Tap to rename, long-press for workspace actions"
            accessibilityLabel={`Workspace ${workspace.name}`}
            accessibilityRole="button"
            onPress={() => startEdit("name")}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            testID="workspace-title"
          >
            <Text
              className="font-t3-bold text-foreground"
              numberOfLines={1}
              style={{ fontSize, letterSpacing: -0.3 * scale }}
            >
              {workspace.name}
            </Text>
          </Pressable>
        </Menu>
      )}
    </View>
  );
}
