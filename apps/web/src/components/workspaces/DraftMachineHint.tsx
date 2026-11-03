import {
  defaultUsableDraftModel,
  draftModelUnavailableReason,
  machineForDraftModel,
} from "@t3tools/client-runtime/state/mesh-layout";
import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { useEnvironments, useEnvironmentProviders } from "../../state/environments";
import type { EnvironmentOption } from "../BranchToolbar.logic";

export function DraftMachineHint({
  selection,
  environmentId,
  machines,
  onMachine,
  onModel,
}: {
  selection: ModelSelection;
  environmentId: EnvironmentId;
  machines: readonly EnvironmentOption[];
  onMachine: (id: EnvironmentId) => void;
  onModel: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const { environments } = useEnvironments();
  const providers = useEnvironmentProviders();
  const configOf = (id: EnvironmentId) => {
    const config = environments.find(
      (environment) => environment.environmentId === id,
    )?.serverConfig;
    return config ? { settings: config.settings, providers: providers.get(id) ?? [] } : null;
  };
  const current = machines.find((machine) => machine.environmentId === environmentId);
  const config = configOf(environmentId);
  const reason = draftModelUnavailableReason(config, selection, current?.projectId ?? null);
  if (!reason) return null;
  const alternative = machineForDraftModel(
    machines.map((machine) => ({
      ...machine,
      connected: machine.connected === true,
      config: configOf(machine.environmentId),
    })),
    selection,
  );
  const local = defaultUsableDraftModel(config, current?.projectId ?? null);
  const provider =
    config?.providers.find((provider) => provider.instanceId === selection.instanceId)
      ?.displayName ?? selection.instanceId;
  return (
    <div role="status" className="text-xs text-muted-foreground">
      {alternative ? (
        <button
          type="button"
          className="underline"
          onClick={() => onMachine(alternative.environmentId)}
        >
          {provider} works on {alternative.label}. Switch machine
        </button>
      ) : local ? (
        <button
          type="button"
          className="underline"
          onClick={() => onModel(local.instanceId, local.model)}
        >
          Use {local.model} here
        </button>
      ) : (
        reason
      )}
    </div>
  );
}
