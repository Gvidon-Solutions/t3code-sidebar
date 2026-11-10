import {
  resolveMachineTagAppearance,
  machineTagPalette,
  type MachineDisplay,
  type ResolvedMachineTagAppearance,
} from "@t3tools/client-runtime/state/machine-display";
import type { ReactNode } from "react";
import { useColorScheme, View, type ViewProps } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useMeshLayoutOptional } from "./useMeshLayout";

/** The one machine tag on the phone: every surface renders this chip. */
export function MachineTag(props: {
  readonly machine: MachineDisplay;
  /** Dim the tag for a machine this device is not connected to or the mesh reports offline. */
  readonly muted?: boolean;
  readonly children?: ReactNode;
  readonly appearance?: ResolvedMachineTagAppearance;
  /** Test hook; defaults to the device colour scheme. */
  readonly theme?: "light" | "dark";
  readonly testID?: string;
  readonly accessibilityLabel?: string;
  readonly style?: ViewProps["style"];
}) {
  const { config } = useMeshLayoutOptional();
  const deviceScheme = useColorScheme() === "dark" ? "dark" : "light";
  if (props.machine.tag.trim() === "") return null;
  const appearance = props.appearance ?? resolveMachineTagAppearance(config);
  const palette = machineTagPalette(props.machine.color, appearance, props.theme ?? deviceScheme);
  return (
    <View
      accessible
      accessibilityLabel={props.accessibilityLabel ?? `Machine: ${props.machine.label}`}
      testID={props.testID}
      className="h-4 flex-row items-center gap-0.5 rounded px-1"
      style={[
        {
          backgroundColor: palette.backgroundColor,
          opacity: props.muted ? 0.45 : 1,
          ...(palette.borderColor ? { borderColor: palette.borderColor, borderWidth: 1 } : {}),
        },
        props.style,
      ]}
    >
      <Text
        className={cn(
          "font-mono text-[10px] font-t3-bold uppercase",
          props.muted ? "text-foreground-muted" : palette.color ? undefined : "text-foreground",
        )}
        style={props.muted || !palette.color ? undefined : { color: palette.color }}
      >
        {props.machine.tag}
      </Text>
      {props.children}
    </View>
  );
}
