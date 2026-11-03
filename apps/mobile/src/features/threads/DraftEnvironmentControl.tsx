import {
  machineDisplayOf,
  machineTagBackground,
} from "@t3tools/client-runtime/state/machine-display";
import { useMeshLayout } from "../workspaces/useMeshLayout";
import { Pressable } from "react-native";
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";

export function DraftEnvironmentControl(props: {
  readonly label: string;
  readonly display?:
    | import("@t3tools/client-runtime/state/machine-display").MachineDisplay
    | undefined;
  readonly environmentId?: string;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly machineKind: EnvironmentMachineKind;
  readonly disabled: boolean;
  readonly onChooseEnvironment: () => void;
}) {
  const { config } = useMeshLayout();
  const machine =
    props.display ??
    machineDisplayOf(config ?? { machines: {} }, props.environmentId ?? "", props.label);
  const disconnected = props.connectionState !== "connected";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Choose machine, ${props.label}, ${disconnected ? "Offline" : "Connected"}`}
      disabled={props.disabled}
      onPress={props.onChooseEnvironment}
      className="flex-row items-center gap-1.5 rounded-xl px-3 py-2 active:opacity-65"
    >
      <Text
        className="rounded px-1 font-mono text-xs text-foreground"
        style={{ backgroundColor: machineTagBackground(machine.color) }}
      >
        {machine.tag}
      </Text>
      <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
        {machine.label}
      </Text>
      <SymbolView name="chevron.right" size={11} tintColorClassName="accent-icon-muted" />
      {disconnected ? <ConnectionStatusDot state="error" pulse={false} size={6} /> : null}
    </Pressable>
  );
}
