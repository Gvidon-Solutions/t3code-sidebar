import type { SidebarWorkspacesConfig, SidebarProjectMount } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import type { MutagenSession } from "./MutagenRunner.ts";

export function endpointMachine(
  config: SidebarWorkspacesConfig,
  origin: string,
  endpoint: MutagenSession["alpha"],
) {
  if (!endpoint.protocol || endpoint.protocol === "local") return origin;
  if (endpoint.protocol !== "ssh" || !endpoint.host) return undefined;
  const matches = [
    ...new Set([
      ...Object.keys(config.machines),
      ...Object.keys(config.machines[origin]?.reach ?? {}),
      ...Object.values(config.projectMounts).flatMap((reps) =>
        reps.map((rep) => rep.environmentId),
      ),
    ]),
  ].filter((id) => {
    const route = config.machines[origin]?.reach?.[id];
    const host = route?.ssh.replace(/:\d+$/, "").split("@").at(-1);
    return (
      endpoint.host === host ||
      endpoint.host === `t3-mesh-${id}` ||
      endpoint.host === config.machines[id]?.label
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}
export function adoptionSides(
  config: SidebarWorkspacesConfig,
  origin: string,
  reps: readonly SidebarProjectMount[],
  session: MutagenSession,
  targetMachine?: string,
) {
  for (const [sourceEndpoint, destination] of [
    [session.alpha, session.beta],
    [session.beta, session.alpha],
  ] as const) {
    const sourceEnvironment = endpointMachine(config, origin, sourceEndpoint);
    const source = reps.find(
      (rep) =>
        rep.role === "primary" &&
        rep.environmentId === sourceEnvironment &&
        normalizeProjectPathForComparison(rep.path) ===
          normalizeProjectPathForComparison(sourceEndpoint.path),
    );
    const machine = targetMachine ?? endpointMachine(config, origin, destination);
    if (source && machine && machine !== source.environmentId)
      return { source, destination, machine };
  }
  return undefined;
}
