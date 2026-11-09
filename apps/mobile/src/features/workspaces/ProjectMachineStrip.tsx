import type { ProjectMachineStripModel } from "@t3tools/client-runtime/state/mesh-layout";
import { machineTagBackground } from "@t3tools/client-runtime/state/machine-display";
import { Fragment, useEffect } from "react";
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
import { cn } from "../../lib/cn";

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
  compact = false,
}: {
  readonly model: ProjectMachineStripModel;
  readonly compact?: boolean;
  readonly onOpen: () => void;
}) {
  if (model.chips.length === 0) return null;
  const chips = compact ? model.chips.slice(0, 1) : model.chips;
  const overflow = model.overflow + model.chips.length - chips.length;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={model.description}
      onPress={onOpen}
      onLongPress={onOpen}
      className="flex-row items-center gap-1"
    >
      {chips.map((chip, index) => (
        <Fragment key={chip.environmentId}>
          {chip.role === "replica" && model.chips[index - 1]?.role !== "replica" ? (
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no"
              className="text-[10px] text-foreground-muted"
            >
              ⇄
            </Text>
          ) : null}
          <View
            className="h-4 flex-row items-center gap-0.5 rounded px-1"
            style={{
              backgroundColor: machineTagBackground(chip.machine.color),
              opacity: chip.muted ? 0.45 : 1,
            }}
          >
            <Text
              className={cn(
                "font-mono text-[10px] font-t3-bold",
                chip.muted && "text-foreground-muted",
              )}
              style={chip.muted ? undefined : { color: chip.machine.color }}
            >
              {chip.machine.tag}
            </Text>
            {chip.role === "replica" && chip.state !== "watching" ? (
              <StatusDot pending={chip.pending} color={colors[chip.tone]} />
            ) : null}
          </View>
        </Fragment>
      ))}
      {overflow > 0 ? <Text className="text-[10px] text-foreground-muted">+{overflow}</Text> : null}
    </Pressable>
  );
}
