import type { ReactNode } from "react";
import {
  machineTagPalette,
  resolveMachineTagAppearance,
  type MachineDisplay,
  type ResolvedMachineTagAppearance,
} from "@t3tools/client-runtime/state/machine-display";

import { useMeshLayoutOptional } from "../../hooks/useMeshLayout";
import { useTheme } from "../../hooks/useTheme";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

/** Sidebar fork: the machine a thread runs on, as a small tag before its title. */
export function MachineTag({
  machine,
  children,
  muted = false,
  description,
  appearance,
}: {
  machine: MachineDisplay;
  children?: ReactNode;
  /** Dim the tag for a machine this device is not connected to or the mesh reports offline. */
  muted?: boolean;
  description?: string;
  /** Test hook; normally resolved from the replicated mesh appearance. */
  appearance?: ResolvedMachineTagAppearance;
}) {
  const { config } = useMeshLayoutOptional();
  const { resolvedTheme } = useTheme();
  if (machine.tag.trim() === "") return null;
  const palette = machineTagPalette(
    machine.color,
    appearance ?? resolveMachineTagAppearance(config),
    resolvedTheme,
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`Machine: ${machine.label}`}
            className={cn(
              "flex h-4 shrink-0 items-center gap-0.5 rounded px-1 font-mono text-3xs font-semibold tracking-tight uppercase",
              muted
                ? "text-muted-foreground opacity-45 grayscale"
                : palette.color
                  ? undefined
                  : "text-foreground",
            )}
            style={{
              backgroundColor: palette.backgroundColor,
              ...(palette.borderColor ? { borderColor: palette.borderColor, borderWidth: 1 } : {}),
              ...(!muted && palette.color ? { color: palette.color } : {}),
            }}
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
