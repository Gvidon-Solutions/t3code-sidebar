import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { VOICE_OPEN_LONG_PRESS_MS, VoiceStripButton } from "./ComposerVoiceMode";
import { VoiceConversationPreview } from "./VoiceConversationPreview";
import { useLiveVoiceThread, useVoiceModeMuted } from "./useVoiceMode";
import { voiceMode } from "./voiceMode";

const BUBBLE_SIZE = 52;
const EDGE = 8;
const PANEL_WIDTH = 260;
/** Right edge, a little below the middle: clear of the header and the new-thread button. */
const DEFAULT_POSITION = { x: 1, y: 0.62 };

/**
 * Sidebar fork: while a voice conversation runs, a round wave button floats
 * over every screen but the thread chat (which has the full strip). Drag it
 * anywhere inside the safe area; where it is left is remembered. A tap opens
 * a small panel: the conversation's newest words, mute and stop. A long press
 * on the bubble or the words opens its thread. Static: it draws nothing on its
 * own between touches.
 */
export function VoiceConversationBubble(props: { readonly hidden: boolean }) {
  const live = useLiveVoiceThread();
  if (props.hidden || live === null) return null;
  return <Bubble target={live.target} title={live.title} />;
}

function Bubble(props: {
  readonly target: { readonly environmentId: string; readonly threadId: string };
  readonly title: string;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const muted = useVoiceModeMuted();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [expanded, setExpanded] = useState(false);

  const stored = AsyncResult.isSuccess(preferences)
    ? preferences.value.voiceBubblePosition
    : undefined;
  const position = stored ?? DEFAULT_POSITION;
  const minX = insets.left + EDGE;
  const minY = insets.top + EDGE;
  const spanX = Math.max(0, width - insets.right - EDGE - BUBBLE_SIZE - minX);
  const spanY = Math.max(0, height - insets.bottom - EDGE - BUBBLE_SIZE - minY);
  const left = minX + position.x * spanX;
  const top = minY + position.y * spanY;

  const x = useSharedValue(left);
  const y = useSharedValue(top);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  // Follows a restored position, a rotation, or the keyboard-free safe area changing.
  useEffect(() => {
    x.set(left);
    y.set(top);
  }, [left, top, x, y]);

  const persist = useCallback(
    (nextX: number, nextY: number) => {
      savePreferences({
        voiceBubblePosition: {
          x: spanX > 0 ? Math.min(1, Math.max(0, (nextX - minX) / spanX)) : 0,
          y: spanY > 0 ? Math.min(1, Math.max(0, (nextY - minY) / spanY)) : 0,
        },
      });
    },
    [minX, minY, savePreferences, spanX, spanY],
  );
  const toggleExpanded = useCallback(() => setExpanded((open) => !open), []);
  const collapse = useCallback(() => setExpanded(false), []);
  const openThread = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setExpanded(false);
    navigation.navigate("Thread", {
      environmentId: props.target.environmentId,
      threadId: props.target.threadId,
    });
  }, [navigation, props.target.environmentId, props.target.threadId]);

  const pan = Gesture.Pan()
    .minDistance(6)
    .onStart(() => {
      startX.set(x.get());
      startY.set(y.get());
      runOnJS(collapse)();
    })
    .onUpdate((event) => {
      x.set(Math.min(minX + spanX, Math.max(minX, startX.get() + event.translationX)));
      y.set(Math.min(minY + spanY, Math.max(minY, startY.get() + event.translationY)));
    })
    .onEnd(() => {
      runOnJS(persist)(x.get(), y.get());
    });
  const longPress = Gesture.LongPress()
    .minDuration(VOICE_OPEN_LONG_PRESS_MS)
    .onStart(() => {
      runOnJS(openThread)();
    });
  const tap = Gesture.Tap().onEnd((_event, success) => {
    if (success) runOnJS(toggleExpanded)();
  });
  // Whichever is recognized first wins: a drag, a hold, or a quick tap.
  const gesture = Gesture.Race(pan, longPress, tap);
  const bubbleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }],
  }));

  // The panel opens toward the middle of the screen from where the bubble sits.
  const panelWidth = Math.min(PANEL_WIDTH, width - 2 * EDGE);
  const panelHorizontal = position.x > 0.5 ? { right: 0 } : { left: 0 };
  const panelVertical = position.y > 0.5 ? { bottom: BUBBLE_SIZE + 8 } : { top: BUBBLE_SIZE + 8 };

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Animated.View
        pointerEvents="box-none"
        style={[{ position: "absolute", width: BUBBLE_SIZE, height: BUBBLE_SIZE }, bubbleStyle]}
      >
        {expanded ? (
          <View
            className="absolute flex-row items-center gap-1 rounded-2xl border border-border bg-card py-1 pr-1 pl-3 shadow-lg"
            style={[{ width: panelWidth }, panelHorizontal, panelVertical]}
          >
            <Pressable
              accessibilityHint="Long press to open the thread you are talking in"
              accessibilityLabel={`Voice conversation: ${props.title}`}
              accessibilityRole="button"
              className="min-w-0 flex-1 gap-0.5 py-1.5 active:opacity-70"
              delayLongPress={VOICE_OPEN_LONG_PRESS_MS}
              onLongPress={openThread}
            >
              <VoiceConversationPreview captions={2} linesPerCaption={2} maxChars={120} />
            </Pressable>
            <VoiceStripButton
              accessibilityLabel={muted ? "Unmute microphone" : "Mute microphone"}
              icon={muted ? "mic.slash" : "mic"}
              onPress={() => voiceMode.toggleMuted()}
            />
            <VoiceStripButton
              accessibilityLabel="End voice conversation"
              icon="stop.fill"
              onPress={() => voiceMode.stop()}
            />
          </View>
        ) : null}
        <GestureDetector gesture={gesture}>
          <View
            accessible
            accessibilityActions={[{ name: "longpress", label: "Open the voice thread" }]}
            accessibilityHint="Shows the voice conversation's controls. Long press opens its thread; drag to move."
            accessibilityLabel={`Voice conversation: ${props.title}`}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            className="items-center justify-center rounded-full bg-primary shadow-lg"
            collapsable={false}
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === "longpress") openThread();
            }}
            onAccessibilityTap={toggleExpanded}
            style={{ width: BUBBLE_SIZE, height: BUBBLE_SIZE }}
          >
            <SymbolView
              name={muted ? "mic.slash" : "waveform"}
              size={22}
              tintColorClassName="accent-primary-foreground"
              type="monochrome"
            />
          </View>
        </GestureDetector>
      </Animated.View>
    </View>
  );
}
