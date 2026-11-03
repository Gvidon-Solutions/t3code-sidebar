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
}: {
  model: ProjectMachineStripModel;
  onOpen: () => void;
}) {
  if (model.chips.length === 0) return null;
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
        {model.chips.map((chip) =>
          chip.role === "primary" ? (
            <MachineTag key={chip.environmentId} machine={chip.machine} />
          ) : (
            <span
              key={chip.environmentId}
              className="flex h-4 items-center gap-0.5 rounded border px-1 font-mono text-3xs font-semibold"
              style={{ borderColor: chip.machine.color, color: chip.machine.color }}
            >
              ⇄ {chip.machine.tag}
              <span
                className={
                  chip.pending
                    ? "size-1.5 rounded-full motion-safe:animate-pulse"
                    : "size-1.5 rounded-full"
                }
                style={{ backgroundColor: colors[chip.tone] }}
              />
            </span>
          ),
        )}
        {model.overflow > 0 ? <span className="text-3xs">+{model.overflow}</span> : null}
      </TooltipTrigger>
      <TooltipPopup>{model.description}</TooltipPopup>
    </Tooltip>
  );
}
