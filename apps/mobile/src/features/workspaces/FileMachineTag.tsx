import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";

import { useWorkspaceEnvironments } from "../../state/workspace";
import { MachineTag } from "./MachineTag";
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
  return <MachineTag machine={machine} />;
}
