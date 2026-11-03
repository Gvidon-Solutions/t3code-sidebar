import {
  machineDisplayOf,
  machineTagBackground,
} from "@t3tools/client-runtime/state/machine-display";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { useMeshLayout } from "./useMeshLayout";

export function FileMachineTag(props: {
  readonly fileEnvironmentId: string;
  readonly threadEnvironmentId?: string;
}) {
  const { config } = useMeshLayout();
  const environments = useWorkspaceEnvironments();
  if (
    props.threadEnvironmentId === undefined ||
    props.threadEnvironmentId === props.fileEnvironmentId
  )
    return null;
  const label =
    environments.find((environment) => environment.environmentId === props.fileEnvironmentId)
      ?.environmentLabel ?? props.fileEnvironmentId;
  const machine = machineDisplayOf(config ?? { machines: {} }, props.fileEnvironmentId, label);
  return (
    <View
      accessible
      accessibilityLabel={`Machine: ${machine.label}`}
      className="self-start rounded px-1.5 py-0.5"
      style={{ backgroundColor: machineTagBackground(machine.color) }}
    >
      <Text className="font-mono text-xs font-t3-bold text-foreground">{machine.tag}</Text>
    </View>
  );
}
