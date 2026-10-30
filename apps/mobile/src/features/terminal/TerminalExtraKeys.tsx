import { useEffect, useEffectEvent, useRef } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { HostPlatform, PendingModifier } from "./terminalInput";

/** Two rows of 40 pt keys plus padding. */
export const TERMINAL_EXTRA_KEYS_HEIGHT = 88;

const REPEAT_DELAY_MS = 350;
const REPEAT_INTERVAL_MS = 70;

type ExtraKey =
  | { readonly kind: "send"; readonly label: string; readonly data: string; readonly repeat?: true }
  | { readonly kind: "modifier"; readonly label: string; readonly modifier: PendingModifier }
  | { readonly kind: "paste"; readonly label: string }
  | { readonly kind: "keyboard"; readonly label: string };

function extraKeyRows(hostPlatform: HostPlatform): ReadonlyArray<ReadonlyArray<ExtraKey>> {
  return [
    [
      { kind: "send", label: "ESC", data: "\u001b" },
      { kind: "send", label: "^C", data: "\u0003" },
      { kind: "send", label: "/", data: "/" },
      { kind: "send", label: "HOME", data: "\u001b[H" },
      { kind: "send", label: "↑", data: "\u001b[A", repeat: true },
      { kind: "send", label: "END", data: "\u001b[F" },
      { kind: "send", label: "PGUP", data: "\u001b[5~", repeat: true },
      { kind: "paste", label: "PASTE" },
    ],
    [
      { kind: "send", label: "TAB", data: "\t" },
      { kind: "modifier", label: "CTRL", modifier: "ctrl" },
      { kind: "modifier", label: hostPlatform === "mac" ? "CMD" : "ALT", modifier: "meta" },
      { kind: "send", label: "←", data: "\u001b[D", repeat: true },
      { kind: "send", label: "↓", data: "\u001b[B", repeat: true },
      { kind: "send", label: "→", data: "\u001b[C", repeat: true },
      { kind: "send", label: "PGDN", data: "\u001b[6~", repeat: true },
      { kind: "keyboard", label: "⌨" },
    ],
  ];
}

/**
 * Termux-style extra keys for the Android terminal (sidebar fork): two fixed
 * rows, no scrolling. Arrows and page keys repeat while held. CTRL/ALT apply
 * to the next key; a long press locks them until tapped again. Stays on screen
 * with the keyboard hidden, so arrows can drive an agent's menus.
 */
export function TerminalExtraKeys(props: {
  readonly hostPlatform: HostPlatform;
  readonly modifier: PendingModifier | null;
  readonly modifierLocked: boolean;
  readonly keyboardVisible: boolean;
  readonly colors: {
    readonly background: string;
    readonly foreground: string;
    readonly border: string;
  };
  readonly onSend: (data: string) => void;
  readonly onModifier: (modifier: PendingModifier, lock: boolean) => void;
  readonly onPaste: () => void;
  readonly onToggleKeyboard: () => void;
}) {
  const repeatRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopRepeat = () => {
    if (repeatRef.current !== null) {
      clearTimeout(repeatRef.current);
      repeatRef.current = null;
    }
  };
  // oxlint-disable-next-line react/exhaustive-effect-dependencies, t3code/no-unreasoned-state-sync -- clears the key-repeat timer on unmount; unmount cleanup; stopRepeat only reads refs.
  useEffect(() => stopRepeat, []);
  // Repeats fire from timers, so an effect event sends through the latest handler.
  const sendRepeat = useEffectEvent((data: string) => props.onSend(data));
  const startRepeat = (data: string) => {
    stopRepeat();
    const tick = () => {
      sendRepeat(data);
      repeatRef.current = setTimeout(tick, REPEAT_INTERVAL_MS);
    };
    repeatRef.current = setTimeout(tick, REPEAT_DELAY_MS);
  };

  return (
    <View
      testID="terminal-extra-keys"
      style={{
        height: TERMINAL_EXTRA_KEYS_HEIGHT,
        paddingVertical: 4,
        paddingHorizontal: 2,
        backgroundColor: props.colors.background,
        borderTopWidth: 1,
        borderTopColor: props.colors.border,
      }}
    >
      {extraKeyRows(props.hostPlatform).map((row, rowIndex) => (
        // oxlint-disable-next-line react/no-array-index-key -- The key rows are a fixed layout per platform.
        <View key={rowIndex} style={{ flex: 1, flexDirection: "row" }}>
          {row.map((key) => {
            const active =
              (key.kind === "modifier" && props.modifier === key.modifier) ||
              (key.kind === "keyboard" && props.keyboardVisible);
            const locked = key.kind === "modifier" && active && props.modifierLocked;
            return (
              <Pressable
                key={key.label}
                accessibilityRole="button"
                accessibilityLabel={key.kind === "keyboard" ? "Toggle keyboard" : key.label}
                accessibilityState={{ selected: active }}
                testID={`terminal-key-${key.label}`}
                delayLongPress={350}
                onPressIn={() => {
                  if (key.kind === "send" && key.repeat) {
                    props.onSend(key.data);
                    startRepeat(key.data);
                  }
                }}
                onPressOut={stopRepeat}
                onPress={() => {
                  if (key.kind === "send") {
                    if (!key.repeat) props.onSend(key.data);
                  } else if (key.kind === "modifier") props.onModifier(key.modifier, false);
                  else if (key.kind === "paste") props.onPaste();
                  else props.onToggleKeyboard();
                }}
                onLongPress={
                  key.kind === "modifier" ? () => props.onModifier(key.modifier, true) : undefined
                }
                style={({ pressed }) => ({
                  flex: 1,
                  margin: 2,
                  borderRadius: 8,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: pressed || active ? props.colors.border : "transparent",
                  borderWidth: locked ? 1.5 : 0,
                  borderColor: props.colors.foreground,
                })}
              >
                <Text
                  numberOfLines={1}
                  style={{
                    color: props.colors.foreground,
                    fontSize: key.label.length > 3 ? 11 : 15,
                    fontWeight: "600",
                  }}
                >
                  {key.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}
