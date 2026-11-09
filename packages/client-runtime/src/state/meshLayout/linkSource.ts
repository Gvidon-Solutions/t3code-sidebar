/** The machine a link starts from: this machine when it can link, otherwise the first one. */
export function defaultLinkSource<Id extends string>(
  sources: ReadonlyArray<{ readonly environmentId: Id }>,
  thisMachineId: Id | null,
): Id | null {
  if (thisMachineId !== null && sources.some((source) => source.environmentId === thisMachineId)) {
    return thisMachineId;
  }
  return sources[0]?.environmentId ?? null;
}
