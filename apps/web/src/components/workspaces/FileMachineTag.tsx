import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";

import { useMeshLayout } from "../../hooks/useMeshLayout";
import { useEnvironments } from "../../state/environments";
import { MachineTag } from "./MachineTag";

export function FileMachineTag(props: {
  readonly fileEnvironmentId: string | undefined;
  readonly threadEnvironmentId: string | null;
}) {
  const { config } = useMeshLayout();
  const { environments } = useEnvironments();
  const id = props.fileEnvironmentId;
  if (id === undefined || id === props.threadEnvironmentId) return null;
  const label = environments.find((environment) => environment.environmentId === id)?.label ?? id;
  return <MachineTag machine={machineDisplayOf(config ?? { machines: {} }, id, label)} />;
}
