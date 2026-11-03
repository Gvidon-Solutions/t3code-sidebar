import {
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ServerConfig,
} from "@t3tools/contracts";

export function draftModelUnavailableReason(
  config: Pick<ServerConfig, "providers" | "settings"> | null | undefined,
  selection: ModelSelection,
  projectId: ProjectId | null,
): string | null {
  if (!config) return "Machine configuration unavailable";
  const provider = config.providers.find(
    (provider) => provider.instanceId === selection.instanceId,
  );
  if (!provider) return "Provider not configured on this machine";
  if (!resolveProjectProviderInstanceEnabled(config.settings, projectId, provider.instanceId))
    return "Provider disabled for this project";
  if (!provider.installed) return "Provider not installed";
  if (provider.auth.status === "unauthenticated") return "Provider not authenticated";
  if (provider.status === "error" || provider.availability === "unavailable")
    return "Provider unavailable";
  if (!provider.models.some((model) => model.slug === selection.model)) return "Model unavailable";
  return null;
}

export interface DraftMachineCandidate {
  readonly environmentId: string;
  readonly connected: boolean;
  readonly usable: boolean;
  readonly primary: boolean;
}

export function machineForDraftModel<
  T extends {
    connected: boolean;
    config: Pick<ServerConfig, "providers" | "settings"> | null | undefined;
    projectId: ProjectId | null;
  },
>(machines: readonly T[], selection: ModelSelection): T | null {
  return (
    machines.find(
      (machine) =>
        machine.connected &&
        draftModelUnavailableReason(machine.config, selection, machine.projectId) === null,
    ) ?? null
  );
}

export function defaultDraftMachine(
  machines: readonly DraftMachineCandidate[],
  remembered: string | null,
): string | null {
  return (
    (
      machines.find((machine) => machine.environmentId === remembered) ??
      machines.find((machine) => machine.connected && machine.usable) ??
      machines.find((machine) => machine.primary) ??
      machines[0]
    )?.environmentId ?? null
  );
}

export function defaultUsableDraftModel(
  config: Pick<ServerConfig, "providers" | "settings"> | null | undefined,
  projectId: ProjectId | null,
): ModelSelection | null {
  if (!config) return null;
  const preferred = config.settings.defaultModelSelection;
  if (preferred && draftModelUnavailableReason(config, preferred, projectId) === null)
    return preferred;
  return (
    config.providers
      .flatMap((provider) =>
        provider.models.map((model) => ({ instanceId: provider.instanceId, model: model.slug })),
      )
      .find((selection) => draftModelUnavailableReason(config, selection, projectId) === null) ??
    null
  );
}
