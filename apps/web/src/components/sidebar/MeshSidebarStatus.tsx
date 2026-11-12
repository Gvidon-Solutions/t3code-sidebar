import { NetworkIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { minuteTickToEpochMs } from "@t3tools/client-runtime/clock";
import {
  deriveMeshFooterStatus,
  meshFooterText,
  meshStatusEnabled,
} from "@t3tools/client-runtime/state/mesh-machines";

import { useMeshLayout } from "../../hooks/useMeshLayout";
import { useMeshOverview } from "../../hooks/useMeshOverview";
import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimaryServerSettingsOrNull } from "../../hooks/useSettings";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function MeshSidebarStatusButton({
  text,
  problem,
  onClick,
}: {
  readonly text: string;
  readonly problem: boolean;
  readonly onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={text}
              className="group/menu-button"
              onClick={onClick}
              size="icon"
            >
              <span className="relative inline-flex size-4 shrink-0 items-center justify-center text-(--sidebar-icon-color) transition-colors group-hover/menu-button:text-sidebar-foreground">
                <NetworkIcon className={problem ? "size-4 text-warning!" : "size-4"} />
                {problem ? (
                  <span
                    aria-hidden
                    data-mesh-status-problem
                    className="pointer-events-none absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-warning ring-2 ring-sidebar"
                  />
                ) : null}
              </span>
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{text}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

/**
 * Fork: the mesh state as one icon in the sidebar's utility row. Neutral when everything is in
 * sync; a warning dot and tint when a machine is offline or reports an error.
 */
export function MeshSidebarStatus() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const primarySettings = usePrimaryServerSettingsOrNull();
  const mesh = useMeshLayout();
  const enabled = meshStatusEnabled({
    primarySettings,
    meshSourceConnected: mesh.source !== null,
  });
  const { machines } = useMeshOverview({ config: mesh.config });
  const now = minuteTickToEpochMs(useNowMinute());
  const status = deriveMeshFooterStatus({ enabled, machines, now });
  if (status.kind === "hidden") return null;
  const text = meshFooterText(status);
  if (text === null) return null;
  return (
    <MeshSidebarStatusButton
      text={text}
      problem={status.severity !== "ok"}
      onClick={() => {
        if (isMobile) setOpenMobile(false);
        void navigate({ to: "/settings/mesh" });
      }}
    />
  );
}
