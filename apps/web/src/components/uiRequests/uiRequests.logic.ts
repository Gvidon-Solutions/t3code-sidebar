import type { EnvironmentId, SidebarWorkspace, UiRequest } from "@t3tools/contracts";

/**
 * The requests (or voice commands) to act on, in order. `seen` holds the last
 * id per environment and is updated in place. The first value read from an
 * environment is a baseline, never acted on: it was asked before this client
 * was listening (or before a reload).
 */
export function takeNewUiRequests<T extends { readonly id: string } = UiRequest>(
  seen: Map<EnvironmentId, string | null>,
  entries: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly request: T | null }>,
): Array<{ readonly environmentId: EnvironmentId; readonly request: T }> {
  const fresh: Array<{ environmentId: EnvironmentId; request: T }> = [];
  for (const { environmentId, request } of entries) {
    if (!seen.has(environmentId)) {
      seen.set(environmentId, request?.id ?? null);
      continue;
    }
    if (request === null || seen.get(environmentId) === request.id) continue;
    seen.set(environmentId, request.id);
    fresh.push({ environmentId, request });
  }
  return fresh;
}

/** A sidebar workspace by id, or else by name ignoring case. Earlier lists win. */
export function findSidebarWorkspace(
  lists: Iterable<ReadonlyArray<SidebarWorkspace>>,
  nameOrId: string,
): SidebarWorkspace | null {
  const all = [...lists].flat();
  const name = nameOrId.trim().toLowerCase();
  return (
    all.find((workspace) => workspace.id === nameOrId) ??
    all.find((workspace) => workspace.name.trim().toLowerCase() === name) ??
    null
  );
}
