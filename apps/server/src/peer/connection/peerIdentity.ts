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
