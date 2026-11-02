import {
  machineTagBackground,
  type MachineDisplay,
} from "@t3tools/client-runtime/state/machine-display";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Sidebar fork: the machine a thread runs on, as a small tinted tag before its title. */
export function MachineTag({ machine }: { machine: MachineDisplay }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`Machine: ${machine.label}`}
            className="flex h-4 shrink-0 items-center rounded px-1 font-mono text-3xs font-semibold tracking-tight uppercase"
            style={{ color: machine.color, backgroundColor: machineTagBackground(machine.color) }}
          />
        }
      >
        {machine.tag}
      </TooltipTrigger>
      <TooltipPopup side="top">{machine.label}</TooltipPopup>
    </Tooltip>
  );
}
