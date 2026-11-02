import {
  deriveMeshFooterStatus,
  meshFooterText,
} from "@t3tools/client-runtime/state/mesh-machines";
import type { SidebarWorkspacesConfig } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { useMeshOverview } from "../../hooks/useMeshOverview";
import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Sidebar fork: one line about the mesh, hidden when it is off or nothing is known. */
export function MeshFooterStatus({ config }: { readonly config: SidebarWorkspacesConfig | null }) {
  const enabled = usePrimarySettings(
    (settings) => settings.meshEnabled && settings.linkedEnvironmentsEnabled,
  );
  const { machines } = useMeshOverview({ config });
  const now = Date.parse(useNowMinute());
  const text = meshFooterText(deriveMeshFooterStatus({ enabled, machines, now }));
  if (text === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            aria-label="Open mesh settings"
            className="mx-2 mb-1 block truncate rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-foreground/8 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            to="/settings/mesh"
          />
        }
      >
        {text}
      </TooltipTrigger>
      <TooltipPopup>{text}</TooltipPopup>
    </Tooltip>
  );
}
