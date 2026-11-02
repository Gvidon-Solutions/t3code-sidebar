import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";

/**
 * One seam for machine edits until the mesh writer replaces the shared-setting fan-out.
 */
export function useMachineConfigWriter() {
  const config = usePrimarySettings((settings) => settings.sidebarWorkspaces);
  const updateSettings = useUpdatePrimarySettings();
  return (edit: (current: SidebarWorkspacesConfig) => SidebarWorkspacesConfig) => {
    updateSettings({ sidebarWorkspaces: edit(config) });
  };
}
