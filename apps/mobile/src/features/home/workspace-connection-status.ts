import type { WorkspaceState } from "../../state/workspaceModel";

export interface WorkspaceConnectionStatusPresentation {
  readonly label: string;
  /** Full sentence for a tooltip or accessibility hint when the label is shortened. */
  readonly detail?: string;
  readonly showsProgress: boolean;
}

function shouldShowWorkspaceConnectionStatus(state: WorkspaceState): boolean {
  if (state.networkStatus === "offline") return true;
  if (state.hasReadyEnvironment) return state.hasSyncingConnectedEnvironment;
  return (
    state.connectionError !== null ||
    state.hasConnectingEnvironment ||
    state.hasPendingShellSnapshot ||
    (state.hasLoadedShellSnapshot && !state.hasReadyEnvironment)
  );
}

function workspaceConnectionStatusLabel(state: WorkspaceState): string {
  if (state.networkStatus === "offline") return "You are offline";
  if (state.hasReadyEnvironment && state.hasSyncingConnectedEnvironment) {
    return state.hasLoadedShellSnapshot ? "Syncing threads..." : "Loading threads...";
  }
  if (state.connectingEnvironments.length > 0) return "Reconnecting…";
  if (state.connectionError !== null) return state.connectionError;
  if (state.hasPendingShellSnapshot) {
    return state.hasLoadedShellSnapshot ? "Syncing threads..." : "Loading threads...";
  }
  return "Not connected";
}

export function workspaceConnectionStatusPresentation(
  state: WorkspaceState,
): WorkspaceConnectionStatusPresentation | null {
  if (!shouldShowWorkspaceConnectionStatus(state)) return null;
  const label = workspaceConnectionStatusLabel(state);
  const connecting = state.connectingEnvironments;
  const detail =
    label === "Reconnecting…"
      ? connecting.length === 1
        ? `Reconnecting to ${connecting[0]!.environmentLabel}`
        : `Reconnecting ${connecting.length} environments`
      : undefined;
  return {
    label,
    ...(detail === undefined ? {} : { detail }),
    showsProgress:
      state.networkStatus !== "offline" &&
      (state.hasReadyEnvironment || state.connectionError === null) &&
      (state.connectingEnvironments.length > 0 || state.hasPendingShellSnapshot),
  };
}
