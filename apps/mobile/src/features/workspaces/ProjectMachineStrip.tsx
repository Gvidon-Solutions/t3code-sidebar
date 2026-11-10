import type { ProjectMachineStripModel } from "@t3tools/client-runtime/state/mesh-layout";
import { Fragment, useEffect } from "react";
import Animated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { Pressable } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { MachineTag } from "./MachineTag";

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
      {model.chips.map((chip, index) => (
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
          <MachineTag machine={chip.machine} muted={chip.muted}>
            {chip.role === "replica" && chip.state !== "watching" ? (
              <StatusDot pending={chip.pending} color={colors[chip.tone]} />
            ) : null}
          </MachineTag>
        </Fragment>
      ))}
      {model.overflow > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Also on ${model.hidden.map((chip) => chip.machine.label).join(", ")}`}
          accessibilityHint="Opens the machines list"
          onLongPress={onOpen}
          onPress={onOpen}
          className="min-h-[24px] min-w-[24px] items-center justify-center"
        >
          <Text className="text-[10px] text-foreground-muted">+{model.overflow}</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}
