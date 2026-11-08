export interface MeshConnectMachine {
  readonly environmentId: string;
  readonly label: string;
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
  const offline = input.machines.filter(
    (machine) => !input.connectedEnvironmentIds.has(machine.environmentId),
  );
  return {
    reconnect: offline.filter((machine) => input.entries.has(machine.environmentId)),
    missing: offline.filter((machine) => !input.entries.has(machine.environmentId)),
    needed: offline.length > 0,
  };
}
