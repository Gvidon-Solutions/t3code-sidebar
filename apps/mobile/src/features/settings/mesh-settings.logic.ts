import type { MeshMachine } from "@t3tools/client-runtime/state/mesh-machines";

export interface MeshSettingsSwitchState {
  readonly linkedEnvironmentsEnabled?: boolean;
  readonly meshEnabled?: boolean;
}

/** Both flags make the mesh work, so the single switch reads as on only when both are. */
export function meshSwitchValue(settings: MeshSettingsSwitchState): boolean {
  return settings.linkedEnvironmentsEnabled === true && settings.meshEnabled === true;
}

/** Turning the mesh on or off also turns linked environments on or off, as the web switch does. */
export function meshTogglePatch(enabled: boolean): {
  readonly linkedEnvironmentsEnabled: boolean;
  readonly meshEnabled: boolean;
} {
  return { linkedEnvironmentsEnabled: enabled, meshEnabled: enabled };
}

export interface MeshLinkSourceOption<Id extends string = string> {
  readonly environmentId: Id;
  readonly label: string;
}

interface LinkableEnvironment<Id extends string = string> {
  readonly environmentId: Id;
  readonly label: string;
  readonly connection: { readonly phase: string };
  readonly serverConfig: {
    readonly settings: { readonly linkedEnvironmentsEnabled: boolean };
    readonly environment: { readonly capabilities: { readonly peerLinks?: boolean } };
  } | null;
}

/** Connected machines this phone can mint a code on and link from. */
export function meshLinkSourceOptions<Id extends string>(
  environments: ReadonlyArray<LinkableEnvironment<Id>>,
): MeshLinkSourceOption<Id>[] {
  return environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.peerLinks === true &&
        environment.serverConfig.settings.linkedEnvironmentsEnabled,
    )
    .map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
    }));
}

/** The phone can link every known machine except the one it links from. */
export function meshLinkTargets(
  machines: ReadonlyArray<MeshMachine>,
  source: string | null,
): MeshMachine[] {
  return machines.filter((machine) => machine.environmentId !== source);
}
