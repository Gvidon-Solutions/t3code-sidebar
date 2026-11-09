import {
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ServerConfig,
} from "@t3tools/contracts";

export type ProviderCatalog = Pick<ServerConfig, "providers"> &
  Partial<Pick<ServerConfig, "managedPolicy">> &
  Partial<Pick<ServerConfig, "settings">>;

export function draftModelUnavailableReason(
  config: ProviderCatalog | null | undefined,
  selection: ModelSelection,
  projectId: ProjectId | null,
): string | null {
  if (!config) return "Machine configuration unavailable";
  const provider = config.providers.find(
    (provider) => provider.instanceId === selection.instanceId,
  );
  if (!provider) return "Provider not configured on this machine";
  if (
    !(config.settings
      ? resolveProjectProviderInstanceEnabled(config.settings, projectId, provider.instanceId)
      : provider.enabled)
  )
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

/**
 * The machine a new draft targets. A remembered machine only wins while it is
 * connected and usable; otherwise the main copy, then any usable machine. When
 * nothing is usable the main copy is named so its card can explain why.
 */
export function defaultDraftMachine(
  machines: readonly DraftMachineCandidate[],
  remembered: string | null,
): string | null {
  const usable = (machine: DraftMachineCandidate) => machine.connected && machine.usable;
  const rememberedMachine = machines.find((machine) => machine.environmentId === remembered);
  if (rememberedMachine && usable(rememberedMachine)) return rememberedMachine.environmentId;
  const primaryUsable = machines.find((machine) => machine.primary && usable(machine));
  if (primaryUsable) return primaryUsable.environmentId;
  const anyUsable = machines.find(usable);
  if (anyUsable) return anyUsable.environmentId;
  return (machines.find((machine) => machine.primary) ?? machines[0])?.environmentId ?? null;
}

/** Null when no model is chosen; otherwise whether the chosen model can run on this machine. */
export function hasSelectedDraftModel(
  config: ProviderCatalog | null | undefined,
  selection: ModelSelection | null,
  projectId: ProjectId | null,
): boolean | null {
  if (selection === null) return null;
  // An empty model is the "no provider yet" placeholder, not a model to explain.
  if (selection.model.trim() === "") return null;
  // An empty catalog has not arrived yet; do not call a known model missing.
  if (!config || config.providers.length === 0) return null;
  return draftModelUnavailableReason(config, selection, projectId) === null;
}

/**
 * Whether a machine can hold a copy of the draft's project: it already has the
 * project, it can host a replica, or the draft has no project (scratch).
 */
export function draftMachineCanHostCopy(input: {
  readonly hasProject: boolean;
  /** Null when this client has not seen the machine's capabilities yet. */
  readonly supportsReplicas: boolean | null | undefined;
  readonly isScratchDraft: boolean;
}): boolean {
  // An unknown capability is not a refusal: only a server known to lack the
  // capability cannot host a copy.
  return input.hasProject || input.isScratchDraft || input.supportsReplicas !== false;
}

/** One machine's answer to "could this draft start here right now". */
export function draftMachineUsable(input: {
  readonly connected: boolean;
  readonly hasUsableModels: boolean | null;
  readonly selectedModelUsable: boolean;
  readonly canHostCopy: boolean;
}): boolean {
  return (
    input.connected &&
    input.hasUsableModels === true &&
    input.selectedModelUsable &&
    input.canHostCopy
  );
}

/** Whether a machine can start a draft for this project: any enabled, usable model. */
export function hasUsableDraftModels(
  config: ProviderCatalog | null | undefined,
  projectId: ProjectId | null,
): boolean | null {
  if (!config) return null;
  return defaultUsableDraftModel(config, projectId) !== null;
}

/**
 * Whether the provider catalogs needed to judge a draft default have arrived.
 * Applying the remembered-machine default before them would mark every machine
 * unusable and pin the draft to its main copy for good.
 */
export function draftMachineCatalogsKnown(
  machines: readonly { readonly environmentId: string; readonly connected: boolean }[],
  knownEnvironmentIds: ReadonlySet<string>,
): boolean {
  return machines.every(
    (machine) => !machine.connected || knownEnvironmentIds.has(machine.environmentId),
  );
}

/**
 * The next machine a host shortcut switches to: only connected machines with
 * a usable model, scanning forward and wrapping. Null when none can take the
 * draft, so the shortcut never selects an offline or model-less card.
 */
export function nextSelectableDraftMachine(
  machines: readonly DraftMachineCandidate[],
  currentEnvironmentId: string | null,
): string | null {
  if (machines.length === 0) return null;
  const start = machines.findIndex((machine) => machine.environmentId === currentEnvironmentId);
  for (let offset = 1; offset <= machines.length; offset += 1) {
    const machine = machines[(start + offset) % machines.length]!;
    if (machine.connected && machine.usable) return machine.environmentId;
  }
  return null;
}

export function defaultUsableDraftModel(
  config: ProviderCatalog | null | undefined,
  projectId: ProjectId | null,
): ModelSelection | null {
  if (!config) return null;
  const preferred = config.settings?.defaultModelSelection ?? null;
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

/**
 * The one rule for remembering a draft's machine: an explicit choice is saved,
 * the automatic default is not, so a temporarily unreachable machine is never
 * replaced in the person's memory.
 */
export function savedDraftMachineChoice(input: {
  readonly remember: boolean;
  readonly preferenceKey: string | null;
  readonly environmentId: string;
}): { readonly preferenceKey: string; readonly environmentId: string } | null {
  if (!input.remember || input.preferenceKey === null) return null;
  return { preferenceKey: input.preferenceKey, environmentId: input.environmentId };
}
