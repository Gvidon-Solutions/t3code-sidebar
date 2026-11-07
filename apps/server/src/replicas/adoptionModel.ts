import type { SidebarProjectMount } from "@t3tools/contracts";
import { normalizeRepresentationPath } from "@t3tools/shared/meshLayout";
import type { MutagenSession } from "./MutagenRunner.ts";

function endpointMachine(
  routes: Readonly<Record<string, string>>,
  origin: string,
  endpoint: MutagenSession["alpha"],
) {
  if (!endpoint.protocol || endpoint.protocol === "local") return origin;
  if (endpoint.protocol !== "ssh" || !endpoint.host) return undefined;
  const matches = Object.entries(routes).filter(([, host]) => endpoint.host === host);
  return matches.length === 1 ? matches[0]![0] : undefined;
}
export function adoptionSides(
  routes: Readonly<Record<string, string>>,
  origin: string,
  reps: readonly SidebarProjectMount[],
  session: MutagenSession,
  targetMachine?: string,
) {
  for (const [sourceEndpoint, destination] of [
    [session.alpha, session.beta],
    [session.beta, session.alpha],
  ] as const) {
    const sourceEnvironment = endpointMachine(routes, origin, sourceEndpoint);
    const source = reps.find(
      (rep) =>
        rep.role === "primary" &&
        rep.environmentId === sourceEnvironment &&
        normalizeRepresentationPath(rep.path) === normalizeRepresentationPath(sourceEndpoint.path),
    );
    const machine = targetMachine ?? endpointMachine(routes, origin, destination);
    if (source && machine && machine !== source.environmentId)
      return { source, destination, machine };
  }
  return undefined;
}
