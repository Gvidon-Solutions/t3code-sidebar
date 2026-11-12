import { NetworkIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { minuteTickToEpochMs } from "@t3tools/client-runtime/clock";
import {
  deriveMeshFooterStatus,
  meshFooterText,
} from "@t3tools/client-runtime/state/mesh-machines";

import { useMeshLayout } from "../../hooks/useMeshLayout";
import { useMeshOverview } from "../../hooks/useMeshOverview";
import { useNowMinute } from "../../hooks/useNowMinute";
import { usePrimarySettings } from "../../hooks/useSettings";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The icon itself, split out so a screenshot harness can render it without the hooks. */
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
            <SidebarMenuButton aria-label={text} onClick={onClick} size="icon">
              <NetworkIcon className={problem ? "text-warning!" : undefined} />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{text}</TooltipPopup>
      </Tooltip>
      {problem ? (
        <span
          aria-hidden
          data-mesh-status-problem
          className="pointer-events-none absolute -top-1 -right-1 size-1.5 rounded-full bg-warning ring-2 ring-sidebar"
        />
      ) : null}
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
  const enabled = usePrimarySettings(
    (settings) => settings.meshEnabled && settings.linkedEnvironmentsEnabled,
  );
  const mesh = useMeshLayout();
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
