import { useSyncExternalStore } from "react";

// Height of the workspace dock at the bottom of Home; 0 while no dock shows.
// The Android floating buttons (rendered outside Home) hide while it shows.
let dockHeight = 0;
const listeners = new Set<() => void>();

export function setWorkspaceDockHeight(height: number) {
  if (height === dockHeight) return;
  dockHeight = height;
  for (const listener of listeners) listener();
}

export function useWorkspaceDockHeight(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => dockHeight,
  );
}
