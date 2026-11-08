import type { ReactNode } from "react";
import {
  machineTagBackground,
  type MachineDisplay,
} from "@t3tools/client-runtime/state/machine-display";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

/** Sidebar fork: the machine a thread runs on, as a small tinted tag before its title. */
export function MachineTag({
  machine,
  children,
  muted = false,
  description,
}: {
  machine: MachineDisplay;
  children?: ReactNode;
  /** Dim the tag for a machine this device is not connected to. */
  muted?: boolean;
  description?: string;
}) {
  if (machine.tag.trim() === "") return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`Machine: ${machine.label}`}
            className={cn(
              "flex h-4 shrink-0 items-center gap-0.5 rounded px-1 font-mono text-3xs font-semibold tracking-tight text-foreground uppercase",
              muted && "opacity-60",
            )}
            style={{ backgroundColor: machineTagBackground(machine.color) }}
          />
        }
      >
        {machine.tag}
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{description ?? machine.label}</TooltipPopup>
    </Tooltip>
  );
}
