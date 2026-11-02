import type { MeshMachine } from "@t3tools/client-runtime/state/mesh-machines";

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

/** Connected machines this app can mint a code on and link from. */
export function linkSourceOptions<Id extends string>(
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

/** Every machine except the one linking, for the target picker. */
export function linkTargetOptions(
  machines: ReadonlyArray<MeshMachine>,
  source: string | null,
): MeshMachine[] {
  return machines.filter((machine) => machine.environmentId !== source);
}

/** A machine known through the mesh but with no connection here yet, with an address to pair at. */
export function shouldOfferConnect(machine: MeshMachine): boolean {
  return !machine.connectedHere && machine.urls.length > 0;
}
