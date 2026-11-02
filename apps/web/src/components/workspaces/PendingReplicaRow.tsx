import {
  replicaStatusCopy,
  type PendingReplicaRow as PendingReplicaRowModel,
} from "@t3tools/client-runtime/state/mesh-layout";
import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import { RefreshCwIcon } from "lucide-react";
import type { SidebarWorkspacesConfig } from "@t3tools/contracts";

import { MachineTag } from "./MachineTag";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Fork: a machine mounting this folder, above its threads until the project registers. */
export function PendingReplicaRow(props: {
  readonly config: SidebarWorkspacesConfig;
  readonly row: PendingReplicaRowModel;
  readonly onRetry: (row: PendingReplicaRowModel) => void;
}) {
  const { row, config } = props;
  const machine = machineDisplayOf(config, row.rep.environmentId, row.rep.environmentId);
  const source = row.rep.source
    ? machineDisplayOf(config, row.rep.source, row.rep.source).label
    : "the source";
  const text = replicaStatusCopy({
    state: row.status.state,
    progress: row.progress,
    conflicts: row.conflicts,
    message: row.message,
    targetLabel: machine.label,
    sourceLabel: source,
  });
  const canRetry = row.status.state === "error" || row.status.state === "conflict";
  return (
    <div
      className="flex h-7 items-center gap-1.5 rounded-md pr-1 pl-7.5 text-xs text-sidebar-muted-foreground"
      data-replica-pending={row.rep.environmentId}
    >
      <MachineTag machine={machine} />
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
          {text}
        </TooltipTrigger>
        <TooltipPopup>{text}</TooltipPopup>
      </Tooltip>
      {canRetry ? (
        <button
          type="button"
          aria-label={`Retry replica on ${machine.label}`}
          className="flex h-5 shrink-0 items-center gap-1 rounded px-1 text-2xs font-medium text-sidebar-foreground hover:bg-foreground/8 focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => props.onRetry(row)}
        >
          <RefreshCwIcon className="size-3" />
          Retry
        </button>
      ) : null}
    </div>
  );
}
