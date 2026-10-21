import { useNavigate } from "@tanstack/react-router";
import { InboxIcon } from "lucide-react";
import { memo } from "react";

import { useInboxState } from "../../state/inbox";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { inboxButtonLabel } from "./inbox.logic";

function InboxCounter({ count, tone }: { count: number; tone: "unread" | "waiting" }) {
  return (
    <span
      aria-hidden
      className={
        tone === "unread"
          ? "pointer-events-none absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-info px-1 text-3xs leading-none font-bold text-white ring-2 ring-sidebar"
          : "pointer-events-none absolute -right-1 -bottom-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-3xs leading-none font-bold text-white ring-2 ring-sidebar"
      }
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * Fork: the inbox entry in the sidebar's utility row. Blue counts issues with
 * unseen news, red counts open issues waiting for the owner's answer.
 */
export const InboxSidebarButton = memo(function InboxSidebarButton() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const counts = useInboxState().counts;
  const label = inboxButtonLabel(counts);
  const onClick = () => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/inbox" });
  };

  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              <InboxIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      {counts.unread > 0 ? <InboxCounter count={counts.unread} tone="unread" /> : null}
      {counts.waiting > 0 ? <InboxCounter count={counts.waiting} tone="waiting" /> : null}
    </SidebarMenuItem>
  );
});
