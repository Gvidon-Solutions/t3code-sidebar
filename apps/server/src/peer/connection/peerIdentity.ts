export const PEER_HOPS_HEADER = "t3-mesh-hops";
export const PEER_HOPS_ERROR = "Relay hops do not match the authenticated peer";

export const parseHops = (header: string | undefined) => header?.split(",");
export const formatHops = (hops: readonly string[]) => hops.join(",");

export function relayHopsAllowed(hops: readonly string[], self: string, target: string) {
  return (
    hops.length === 1 && !!hops[0] && hops[0] !== self && hops[0] !== target && self !== target
  );
}

export function authenticatedPeerHops(
  hops: readonly string[] | undefined,
  peerEnvironmentId: string,
  selfEnvironmentId: string,
): boolean {
  return (
    hops === undefined ||
    (peerEnvironmentId !== selfEnvironmentId &&
      ((hops.length === 1 && hops[0] === peerEnvironmentId) ||
        (hops.length === 2 &&
          hops[1] === peerEnvironmentId &&
          !!hops[0] &&
          hops[0] !== peerEnvironmentId &&
          hops[0] !== selfEnvironmentId)))
  );
}
