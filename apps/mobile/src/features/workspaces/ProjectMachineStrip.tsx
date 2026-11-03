import type { ProjectMachineStripModel } from "@t3tools/client-runtime/state/mesh-layout";
import { machineTagBackground } from "@t3tools/client-runtime/state/machine-display";
import { useEffect } from "react";
import Animated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";

const colors = {
  green: "#22c55e",
  neutral: "#a3a3a3",
  amber: "#f59e0b",
  red: "#ef4444",
  grey: "#737373",
};

function StatusDot({ pending, color }: { readonly pending: boolean; readonly color: string }) {
  const opacity = useSharedValue(1);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the native pending-status animation and cancels it on unmount.
  useEffect(() => {
    opacity.set(
      pending
        ? withRepeat(
            withTiming(0.3, { duration: 800, reduceMotion: ReduceMotion.System }),
            -1,
            true,
            undefined,
            ReduceMotion.System,
          )
        : 1,
    );
    return () => cancelAnimation(opacity);
  }, [opacity, pending]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    <Animated.View
      style={[{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }, style]}
    />
  );
}

export function ProjectMachineStrip({
  model,
  onOpen,
}: {
  readonly model: ProjectMachineStripModel;
  readonly onOpen: () => void;
}) {
  if (model.chips.length === 0) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={model.description}
      onPress={onOpen}
      onLongPress={onOpen}
      className="flex-row items-center gap-1"
    >
      {model.chips.map((chip) => (
        <View
          key={chip.environmentId}
          className="h-4 flex-row items-center gap-0.5 rounded px-1"
          style={{
            borderWidth: chip.role === "replica" ? 1 : 0,
            borderColor: chip.machine.color,
            backgroundColor:
              chip.role === "primary" ? machineTagBackground(chip.machine.color) : "transparent",
          }}
        >
          <Text
            className="font-mono text-[10px] font-t3-bold"
            style={{ color: chip.machine.color }}
          >
            {chip.role === "replica" ? "⇄ " : ""}
            {chip.machine.tag}
          </Text>
          {chip.role === "replica" ? (
            <StatusDot pending={chip.pending} color={colors[chip.tone]} />
          ) : null}
        </View>
      ))}
      {model.overflow > 0 ? (
        <Text className="text-[10px] text-foreground-muted">+{model.overflow}</Text>
      ) : null}
    </Pressable>
  );
}
