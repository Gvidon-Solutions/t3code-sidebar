import { EnvironmentId } from "@t3tools/contracts";
import { openOpenFileDialog } from "../files/openFileDialogState";
import {
  representationRow,
  type PendingReplicaRow,
} from "@t3tools/client-runtime/state/mesh-layout";
import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import type {
  ReplicaLiveStatus,
  SidebarProjectMount,
  SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { MachineTag } from "./MachineTag";

export interface MachinesDialogMachine {
  readonly environmentId: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly reason: string | null;
}

/** Fork: every representation of one logical project, with its machine, role and state. */
export function MachinesDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly config: SidebarWorkspacesConfig;
  readonly logicalKey: string;
  readonly machines: ReadonlyArray<MachinesDialogMachine>;
  readonly liveStatuses: ReadonlyArray<ReplicaLiveStatus>;
  readonly onAddReplica: (environmentId: string) => void;
  readonly onMakePrimary: (environmentId: string) => void;
  readonly onRemove: (environmentId: string) => void;
  readonly onRetry: (row: PendingReplicaRow) => void;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const reps: ReadonlyArray<SidebarProjectMount> =
    props.config.projectMounts[props.logicalKey] ?? [];
  const present = new Set(reps.map((rep) => rep.environmentId));
  const candidates = props.machines.filter(
    (machine) => !machine.disabled && !present.has(machine.environmentId),
  );
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Machines</DialogTitle>
          <DialogDescription>
            {props.title}. Folders on each machine, and which one runs git and builds.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {reps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No machines have this project yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {reps.map((rep) => {
                const machine = machineDisplayOf(
                  props.config,
                  rep.environmentId,
                  rep.environmentId,
                );
                const status = representationRow(
                  props.config,
                  props.liveStatuses,
                  props.logicalKey,
                  rep,
                );
                const copies =
                  props.config.projectMountStatus[props.logicalKey]?.[rep.environmentId]
                    ?.conflictCopies;
                const retry = status.retry;
                return (
                  <div
                    key={rep.environmentId}
                    className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
                    data-replica-representation={rep.environmentId}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <MachineTag machine={machine} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {machine.label}
                      </span>
                      <Badge variant={rep.role === "primary" ? "default" : "secondary"}>
                        {rep.role === "primary" ? "Primary" : "Replica"}
                      </Badge>
                    </div>
                    <div className="break-all font-mono text-2xs text-muted-foreground">
                      {rep.path}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className={
                          status.text.startsWith("Can't")
                            ? "text-destructive-foreground"
                            : "text-muted-foreground"
                        }
                      >
                        {status.text}
                      </span>
                      {copies ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            props.onOpenChange(false);
                            openOpenFileDialog(
                              EnvironmentId.make(copies.environmentId),
                              copies.path,
                            );
                          }}
                        >
                          Open copies
                        </Button>
                      ) : null}
                      {rep.role === "replica" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => props.onMakePrimary(rep.environmentId)}
                        >
                          Make primary
                        </Button>
                      ) : null}
                      {status.retry ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            if (retry) props.onRetry(retry);
                          }}
                        >
                          Retry
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setRemoving(rep.environmentId)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {candidates.length > 0 ? (
            <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
              <span className="text-xs font-medium text-muted-foreground">Add replica on…</span>
              <div className="flex flex-wrap gap-2">
                {candidates.map((machine) => {
                  const display = machineDisplayOf(
                    props.config,
                    machine.environmentId,
                    machine.label,
                  );
                  return (
                    <Button
                      key={machine.environmentId}
                      size="sm"
                      variant="outline"
                      onClick={() => props.onAddReplica(machine.environmentId)}
                    >
                      <MachineTag machine={display} />
                      {display.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </DialogPanel>
      </DialogPopup>
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this replica?</AlertDialogTitle>
            <AlertDialogDescription>
              The sync stops and its representation is removed. Files already on the machine stay
              where they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={() => {
                if (removing !== null) props.onRemove(removing);
                setRemoving(null);
              }}
            >
              Remove
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Dialog>
  );
}
