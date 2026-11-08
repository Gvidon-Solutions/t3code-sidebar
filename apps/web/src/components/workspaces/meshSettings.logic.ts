import type { MeshMachine } from "@t3tools/client-runtime/state/mesh-machines";
import { plainErrorMessage } from "@t3tools/client-runtime/errors";
export {
  meshUpdateProblems,
  meshUpdatePrompt,
  offlineMachinePrompt,
  refusedLinkPrompt,
  replicaProblemPrompt,
  type MeshUpdateProblem,
} from "@t3tools/client-runtime/state/mesh-machines";

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

/** Error class names and transport noise never reach a toast; only the sentence to act on. */
export function plainFailureText(failure: unknown): string {
  const message =
    typeof failure === "object" && failure !== null && "message" in failure
      ? (failure as { readonly message?: unknown }).message
      : undefined;
  const text =
    typeof message === "string" && message.trim() ? message : plainErrorMessage(failure, "");
  return text.replace(/^[A-Za-z]*Error:\s*/u, "").trim() || "Try again.";
}

/** A single-machine client has nothing to choose, so the source picker stays hidden. */
export function showsLinkSourcePicker(sources: ReadonlyArray<unknown>): boolean {
  return sources.length > 1;
}
