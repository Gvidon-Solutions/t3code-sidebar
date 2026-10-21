import { useState, type ComponentProps } from "react";
import { useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NewThreadButton } from "../../components/NewThreadButton";
import {
  androidHomeFabPosition,
  type AndroidHomeFabLayout as SharedAndroidHomeFabLayout,
} from "./AndroidHomeFab.shared";
import { useWorkspaceState } from "../../state/workspace";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { HomeTalkButton, TALK_BUTTON_SIZE } from "../voice-mode/HomeTalkButton";
import { useWorkspaceDockHeight } from "../workspaces/workspaceDockInset";

export function AndroidHomeFabLayout(props: ComponentProps<typeof SharedAndroidHomeFabLayout>) {
  const insets = useSafeAreaInsets();
  const { appearance } = useAppearancePreferences();
  const { fontScale } = useWindowDimensions();
  const [layoutWidth, setLayoutWidth] = useState<number | null>(null);
  const { state } = useWorkspaceState();
  const dockHeight = useWorkspaceDockHeight();
  const { fabSize } = useAndroidControlSizing();
  const fabPosition = androidHomeFabPosition(insets.bottom, props.sidebar);
  const fabBottom = dockHeight > 0 ? dockHeight + 16 : fabPosition.bottom;

  // Remount only the FAB when its font or pane changes to clear the cached expanded width.
  // The split-view sidebar has no FAB: the navigation rail carries New thread. On phones it
  // keeps Material's 16dp corner margin; the bottom bar already consumes the gesture inset.
  return (
    <View className="flex-1" onLayout={(event) => setLayoutWidth(event.nativeEvent.layout.width)}>
      {props.children}
      {/* Sidebar fork: a compact button that floats above the workspace dock and
          never unfolds into "New thread", with the voice "Talk" button beside it. */}
      {!props.disabled && !props.sidebar && state.hasConnections && layoutWidth !== null ? (
        <>
          <NewThreadButton
            key={`${appearance.baseFontSize}:${fontScale}:${layoutWidth}`}
            extended
            expanded={false}
            onPress={props.onStartNewTask}
            className="absolute"
            style={{ ...fabPosition, bottom: fabBottom }}
          />
          <View
            className="absolute"
            pointerEvents="box-none"
            style={{
              right: fabPosition.right + fabSize + 12,
              bottom: fabBottom + (fabSize - TALK_BUTTON_SIZE) / 2,
            }}
          >
            <HomeTalkButton />
          </View>
        </>
      ) : null}
    </View>
  );
}
