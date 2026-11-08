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

export interface MeshPromptMachine {
  readonly label: string;
  readonly online: boolean;
  readonly detail?: string | null;
}

/** A prepared request for the mesh setup thread: current state, problems and the controls. */
export function meshSetupPrompt(
  machines: ReadonlyArray<MeshPromptMachine>,
  problems: ReadonlyArray<string> = [],
): string {
  const list = machines.map(
    (machine) => `${machine.label} (${machine.online ? "online" : (machine.detail ?? "offline")})`,
  );
  return [
    "Help me set up my T3 mesh.",
    "",
    `Machines: ${list.length > 0 ? list.join(", ") : "none yet"}.`,
    problems.length > 0
      ? `Problems:\n${problems.map((problem) => `- ${problem}`).join("\n")}`
      : "No known problems.",
    "",
    "The desired state lives in one mesh config. You can read it with `t3ctl mesh config get`, preview with `t3ctl mesh config plan`, apply with `t3ctl mesh config apply`, and check reconciliation with `t3ctl mesh status`. The same tools are available as MCP `t3_mesh_config_get`, `t3_mesh_config_plan`, `t3_mesh_config_apply` and `t3_mesh_status`.",
    "Ask me what I want the mesh to do, then plan it, show me the plan, and apply it once I agree.",
  ].join("\n");
}
