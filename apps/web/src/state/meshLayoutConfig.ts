import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

/**
 * Latest mesh layout config for code that runs outside React (new-thread commands).
 * The provider mirrors its snapshot here; readers must treat null as "no mesh".
 */
let snapshot: SidebarWorkspacesConfig | null = null;

export function setMeshLayoutConfigSnapshot(config: SidebarWorkspacesConfig | null): void {
  snapshot = config;
}

export function readMeshLayoutConfigSnapshot(): SidebarWorkspacesConfig | null {
  return snapshot;
}
