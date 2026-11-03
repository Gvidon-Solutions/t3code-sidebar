import type { ReactNode } from "react";
import {
  machineTagBackground,
  type MachineDisplay,
} from "@t3tools/client-runtime/state/machine-display";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Sidebar fork: the machine a thread runs on, as a small tinted tag before its title. */
export function MachineTag({
  machine,
  children,
}: {
  machine: MachineDisplay;
  children?: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`Machine: ${machine.label}`}
            className="flex h-4 shrink-0 items-center gap-0.5 rounded px-1 font-mono text-3xs font-semibold tracking-tight text-foreground uppercase"
            style={{ backgroundColor: machineTagBackground(machine.color) }}
          />
        }
      >
        {machine.tag}
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{machine.label}</TooltipPopup>
    </Tooltip>
  );
}
