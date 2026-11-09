export interface MeshConnectMachine {
  readonly environmentId: string;
  readonly label: string;
  /** The mesh reports the machine online; an offline machine is not a connection to fix. */
  readonly online?: boolean;
}

export interface MeshConnectCatalogEntry {
  readonly enabled: boolean;
}

export interface MeshConnectPlan {
  /** Saved environments on mesh machines that this device can switch on. */
  readonly reconnect: ReadonlyArray<MeshConnectMachine>;
  /** Mesh machines with no saved connection on this device. */
  readonly missing: ReadonlyArray<MeshConnectMachine>;
  /** Nothing to do when every mesh machine is already connected here. */
  readonly needed: boolean;
}

/**
 * First run with a mesh: which machines this device is not connected to, split
 * into saved connections it can switch back on and machines it has never added.
 */
export function planMeshConnect(input: {
  readonly machines: ReadonlyArray<MeshConnectMachine>;
  readonly connectedEnvironmentIds: ReadonlySet<string>;
  readonly entries: ReadonlyMap<string, MeshConnectCatalogEntry>;
}): MeshConnectPlan {
  // An offline machine cannot be switched on by a connection action: wait for it
  // to come back instead of telling the person their device is not connected.
  const offline = input.machines.filter(
    (machine) =>
      machine.online !== false && !input.connectedEnvironmentIds.has(machine.environmentId),
  );
  // A saved connection that is already enabled needs no action from this prompt:
  // switching it on again would be a no-op while the machine is simply down.
  const reconnectable = offline.filter(
    (machine) => input.entries.get(machine.environmentId)?.enabled === false,
  );
  const missing = offline.filter((machine) => !input.entries.has(machine.environmentId));
  return {
    reconnect: reconnectable,
    missing,
    needed: reconnectable.length > 0 || missing.length > 0,
  };
}

/** The machines this prompt would act on, stable for dismissing exactly that set. */
function meshConnectActionableIds(plan: MeshConnectPlan): string[] {
  return [...plan.reconnect, ...plan.missing]
    .map((machine) => machine.environmentId)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Whether the prompt should appear. Dismissal covers the machines it acted on
 * at the time, so a machine that joins the mesh later brings it back.
 */
export function shouldShowMeshConnectPrompt(
  plan: MeshConnectPlan,
  dismissedEnvironmentIds: ReadonlyArray<string>,
): boolean {
  if (!plan.needed) return false;
  const dismissed = new Set(dismissedEnvironmentIds);
  return meshConnectActionableIds(plan).some((environmentId) => !dismissed.has(environmentId));
}

/** A stable, deduplicated dismissal list. */
function mergeDismissed(
  dismissedEnvironmentIds: ReadonlyArray<string>,
  environmentIds: ReadonlyArray<string>,
): string[] {
  return [...new Set([...dismissedEnvironmentIds, ...environmentIds])].sort((left, right) =>
    left.localeCompare(right),
  );
}

/** Remember the machines one action settled, so a failed one asks again. */
export function dismissMeshConnectIds(
  dismissedEnvironmentIds: ReadonlyArray<string>,
  environmentIds: ReadonlyArray<string>,
): string[] {
  return mergeDismissed(dismissedEnvironmentIds, environmentIds);
}

/** The persisted dismissal after acting or choosing "Not now". */
export function dismissMeshConnectPrompt(
  dismissedEnvironmentIds: ReadonlyArray<string>,
  plan: MeshConnectPlan,
): string[] {
  return mergeDismissed(dismissedEnvironmentIds, meshConnectActionableIds(plan));
}

/** Drop machines that left the mesh; a current machine is never forgotten here. */
export function pruneMeshConnectDismissed(
  dismissedEnvironmentIds: ReadonlyArray<string>,
  currentEnvironmentIds: ReadonlyArray<string>,
): string[] {
  const current = new Set(currentEnvironmentIds);
  return dismissedEnvironmentIds.filter((environmentId) => current.has(environmentId));
}
