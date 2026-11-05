import { Fragment } from "react";
import type { ProjectMachineStripModel } from "@t3tools/client-runtime/state/mesh-layout";
import { MachineTag } from "./MachineTag";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const colors = {
  green: "#22c55e",
  neutral: "#a3a3a3",
  amber: "#f59e0b",
  red: "#ef4444",
  grey: "#737373",
};

export function ProjectMachineStrip({
  model,
  onOpen,
  compact = false,
}: {
  model: ProjectMachineStripModel;
  compact?: boolean;
  onOpen: () => void;
}) {
  if (model.chips.length === 0) return null;
  const chips = compact ? model.chips.slice(0, 1) : model.chips;
  const overflow = model.overflow + model.chips.length - chips.length;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={model.description}
            className="flex shrink-0 items-center gap-1"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            onKeyDown={(event) => event.stopPropagation()}
          />
        }
      >
        {chips.map((chip, index) => (
          <Fragment key={chip.environmentId}>
            {chip.role === "replica" && model.chips[index - 1]?.role !== "replica" ? (
              <span aria-hidden="true" className="text-3xs text-sidebar-muted-foreground">
                ⇄
              </span>
            ) : null}
            <MachineTag machine={chip.machine}>
              {chip.role === "replica" && chip.state !== "watching" ? (
                <span
                  aria-hidden="true"
                  className={
                    chip.pending
                      ? "size-1.5 rounded-full motion-safe:animate-pulse"
                      : "size-1.5 rounded-full"
                  }
                  style={{ backgroundColor: colors[chip.tone] }}
                />
              ) : null}
            </MachineTag>
          </Fragment>
        ))}
        {overflow > 0 ? <span className="text-3xs">+{overflow}</span> : null}
      </TooltipTrigger>
      <TooltipPopup>{model.description}</TooltipPopup>
    </Tooltip>
  );
}
