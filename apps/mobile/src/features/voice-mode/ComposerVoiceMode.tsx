import { useNavigation } from "@react-navigation/native";
import type { VoiceModePhase } from "@t3tools/client-runtime/voice-mode";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { useLiveVoiceThread, useVoiceModeMuted } from "./useVoiceMode";
import {
  selectVoiceAudioDevice,
  useVoiceAudioState,
  type VoiceAudioDevice,
} from "./voiceAudioRoute";
import { VoiceConversationPreview } from "./VoiceConversationPreview";
import { voiceMode } from "./voiceMode";
import { describeVoiceAudioDevice } from "./voiceModePresentation";

/** How long to hold the panel's words, or the bubble, for more. */
export const VOICE_OPEN_LONG_PRESS_MS = 400;
/** The panel keeps this many lines of the conversation, so it never jumps as words stream in. */
const PANEL_LINES = 4;
const PANEL_LINE_HEIGHT = 20;

const DEVICE_ICON: Record<VoiceAudioDevice["route"], AppSymbolName> = {
  bluetooth: "headphones",
  wired: "headphones",
  speaker: "speaker.wave.2",
  earpiece: "iphone",
};

/** Starts or ends a voice conversation on the thread. Lit while one is live there. */
export function ComposerVoiceModeButton(props: {
  readonly phase: VoiceModePhase;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const live = props.phase !== "idle";
  return (
    <Pressable
      accessibilityLabel={live ? "End voice conversation" : "Start voice conversation"}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, selected: live }}
      className="size-[44px] shrink-0 items-center justify-center active:opacity-70"
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ opacity: props.disabled ? 0.4 : 1 }}
    >
      <View
        className={cn(
          "size-[30px] items-center justify-center rounded-full",
          live ? "bg-primary" : undefined,
        )}
      >
        <SymbolView
          name="waveform"
          size={live ? 16 : 20}
          tintColorClassName={live ? "accent-primary-foreground" : "accent-icon"}
          type="monochrome"
        />
      </View>
    </Pressable>
  );
}

/** A round icon control in the voice strips and the bubble's panel. */
export function VoiceStripButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      className="size-9 items-center justify-center rounded-full active:bg-subtle"
      hitSlop={4}
      onPress={props.onPress}
    >
      <SymbolView name={props.icon} size={16} tintColorClassName="accent-icon" type="monochrome" />
    </Pressable>
  );
}

/** A rounded choice in the panel's menu. */
function VoiceMenuChip(props: {
  readonly label: string;
  readonly icon?: AppSymbolName;
  readonly selected?: boolean;
  readonly accessibilityHint?: string;
  readonly onPress: () => void;
}) {
  const selected = props.selected === true;
  return (
    <Pressable
      accessibilityHint={props.accessibilityHint}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={cn(
        "h-8 flex-row items-center gap-1.5 rounded-full border px-3 active:opacity-70",
        selected ? "border-primary bg-subtle" : "border-border",
      )}
      hitSlop={2}
      onPress={props.onPress}
    >
      {props.icon ? (
        <SymbolView
          name={props.icon}
          size={14}
          tintColorClassName={selected ? "accent-primary" : "accent-icon"}
          type="monochrome"
        />
      ) : null}
      <Text
        className={cn("text-sm", selected ? "font-t3-medium text-primary" : "text-foreground")}
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** Where the conversation runs, when the panel sits on another thread. */
interface ElsewhereConversation {
  readonly title: string;
  readonly onOpen: () => void;
  /** Moves the conversation to the thread on screen; absent where voice cannot start. */
  readonly onTalkHere?: () => void;
}

/**
 * What a long press on the words swaps in: going to the conversation (from
 * another thread) and the device the call goes through. A headset connected
 * from the quick settings shade joins the list and takes the call by itself;
 * there is no way to system settings, since leaving the app ends the
 * conversation. "Back" or any action that leaves returns to the words;
 * picking a device keeps the menu so the check mark shows where sound went.
 */
function VoicePanelMenu(props: {
  readonly elsewhere: ElsewhereConversation | null;
  readonly onClose: () => void;
}) {
  const audio = useVoiceAudioState();
  const closeAnd = (action: () => void) => () => {
    props.onClose();
    action();
  };
  return (
    <View className="min-w-0 flex-1 justify-center gap-2 py-1">
      <View className="flex-row flex-wrap items-center gap-1.5">
        <VoiceMenuChip icon="chevron.left" label="Back" onPress={props.onClose} />
        {props.elsewhere ? (
          <VoiceMenuChip
            accessibilityHint={`Opens ${props.elsewhere.title}`}
            icon="arrow.up.right"
            label="Open conversation"
            onPress={closeAnd(props.elsewhere.onOpen)}
          />
        ) : null}
        {props.elsewhere?.onTalkHere ? (
          <VoiceMenuChip label="Talk here" onPress={closeAnd(props.elsewhere.onTalkHere)} />
        ) : null}
      </View>
      {audio.devices.length > 0 ? (
        <ScrollView
          horizontal
          contentContainerClassName="items-center gap-1.5"
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
        >
          {audio.devices.map((device) => (
            <VoiceMenuChip
              key={device.id}
              accessibilityHint="Plays the conversation here and listens through it"
              icon={DEVICE_ICON[device.route]}
              label={describeVoiceAudioDevice(device)}
              selected={device.selected}
              onPress={() => {
                void Haptics.selectionAsync();
                selectVoiceAudioDevice(device.id);
              }}
            />
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

/**
 * Sidebar fork: the voice panel above the composer, the same on the
 * conversation's own thread and on every other one. Mute and stop are always
 * one tap away on the right. The rest shows the newest words, four lines
 * tall so it holds still while they stream; a long press swaps them for a
 * short menu (VoicePanelMenu) in the same place.
 */
function VoicePanel(props: { readonly elsewhere: ElsewhereConversation | null }) {
  const muted = useVoiceModeMuted();
  const [menuOpen, setMenuOpen] = useState(false);
  // The menu replaces the words only once the finger lifts: swapping out the
  // pressed view mid-touch leaves the responder stale and eats the next tap.
  const heldLong = useRef(false);
  const openMenu = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setMenuOpen(true);
  };
  return (
    <View className="mb-2 flex-row items-center gap-1 rounded-2xl border border-composer-border bg-card py-1 pr-1 pl-3">
      {menuOpen ? (
        <VoicePanelMenu elsewhere={props.elsewhere} onClose={() => setMenuOpen(false)} />
      ) : (
        <Pressable
          accessibilityActions={[{ name: "longpress", label: "Voice options" }]}
          accessibilityHint="Long press for voice options"
          accessibilityLabel={
            props.elsewhere ? `Voice conversation: ${props.elsewhere.title}` : "Voice conversation"
          }
          className="min-w-0 flex-1 flex-row gap-2 py-1"
          delayLongPress={VOICE_OPEN_LONG_PRESS_MS}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "longpress") openMenu();
          }}
          onLongPress={() => {
            heldLong.current = true;
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          }}
          onPressOut={() => {
            if (!heldLong.current) return;
            heldLong.current = false;
            setMenuOpen(true);
          }}
          style={{ minHeight: PANEL_LINES * PANEL_LINE_HEIGHT }}
        >
          <View className="pt-0.5">
            <SymbolView
              name="waveform"
              size={14}
              tintColorClassName={muted ? "accent-icon" : "accent-primary"}
            />
          </View>
          <View className="min-w-0 flex-1">
            <VoiceConversationPreview captions={1} linesPerCaption={PANEL_LINES} maxChars={320} />
          </View>
        </Pressable>
      )}
      <View className="self-stretch justify-center gap-0.5">
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
    </View>
  );
}

/**
 * Above the composer of every other thread while a conversation runs
 * elsewhere on this device; its menu opens the conversation or moves it here
 * (`onTalkHere`, only where voice can start). Renders nothing while no
 * conversation runs.
 */
export function ComposerVoiceElsewhereStrip(props: { readonly onTalkHere?: () => void }) {
  const navigation = useNavigation();
  const live = useLiveVoiceThread();
  if (live === null) return null;
  return (
    <VoicePanel
      elsewhere={{
        title: live.title,
        onOpen: () =>
          navigation.navigate("Thread", {
            environmentId: live.target.environmentId,
            threadId: live.target.threadId,
          }),
        ...(props.onTalkHere ? { onTalkHere: props.onTalkHere } : {}),
      }}
    />
  );
}

/** The panel on the conversation's own thread. Render only while it is connecting or active. */
export function ComposerVoiceStrip() {
  return <VoicePanel elsewhere={null} />;
}
