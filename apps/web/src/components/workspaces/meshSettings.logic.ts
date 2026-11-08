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

/** Error class names and transport noise never reach a toast; only the sentence to act on. */
export function plainFailureText(failure: unknown): string {
  const message =
    typeof failure === "object" && failure !== null && "message" in failure
      ? (failure as { readonly message?: unknown }).message
      : undefined;
  const text = typeof message === "string" && message.trim() ? message : String(failure);
  return text.replace(/^[A-Za-z]*Error:\s*/u, "").trim() || "Try again.";
}

/** A single-machine client has nothing to choose, so the source picker stays hidden. */
export function showsLinkSourcePicker(sources: ReadonlyArray<unknown>): boolean {
  return sources.length > 1;
}

export interface MeshUpdateProblem {
  readonly revision: string;
  readonly environmentId: string;
  readonly reason: string;
  readonly target: string;
}

/** Failed mesh updates recorded by the rollout, shown as problems with an agent action. */
export function meshUpdateProblems(
  document: Readonly<Record<string, { readonly v: unknown }>>,
): MeshUpdateProblem[] {
  return Object.entries(document).flatMap(([key, entry]) => {
    if (!key.startsWith("mesh.updateFailure/")) return [];
    const value = entry.v;
    if (typeof value !== "object" || value === null) return [];
    const { environmentId, reason, target } = value as Record<string, unknown>;
    if (typeof environmentId !== "string" || typeof reason !== "string") return [];
    return [
      {
        revision: decodeURIComponent(key.slice("mesh.updateFailure/".length)),
        environmentId,
        reason,
        target: typeof target === "string" ? target : "the new version",
      },
    ];
  });
}

export function meshUpdatePrompt(problem: MeshUpdateProblem, machineLabel: string): string {
  return [
    `The T3 update to ${problem.target} failed on ${machineLabel}.`,
    `Reported reason: ${problem.reason}`,
    "Check the mesh update status and the diagnostics for that machine, fix the cause, roll the update back if it is stuck, then apply a fresh mesh config revision and report what you changed.",
  ].join("\n");
}

export function offlineMachinePrompt(machineLabel: string, status: string): string {
  return [
    `${machineLabel} is offline (${status}).`,
    "Check why this machine cannot reach the mesh, restore its connection, and confirm its projects and copies reconcile again. Report what you changed.",
  ].join("\n");
}

export function replicaProblemPrompt(projectTitle: string, machineLabel: string): string {
  return `Fix the copy of ${projectTitle} on ${machineLabel}. It cannot reach its main copy. Check the replica state and repair it, then report what you changed.`;
}

export function refusedLinkPrompt(input: {
  readonly source: string;
  readonly target: string;
  readonly reason: string;
}): string {
  return [
    `Linking ${input.target} from ${input.source} failed: ${input.reason}`,
    "Diagnose the pairing or connection problem, create a fresh pairing code if needed, link the machine, and confirm the mesh layout converges. Report what you changed.",
  ].join("\n");
}
