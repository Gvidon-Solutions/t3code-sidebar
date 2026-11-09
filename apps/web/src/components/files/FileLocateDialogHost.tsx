import { useAtomValue } from "@effect/atom-react";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import type { EnvironmentId, FilesLocateResult } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { environmentSummaries } from "~/state/presentation";
import { useMeshLayout } from "~/hooks/useMeshLayout";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";
import { useFileLocateDialogStore } from "./locateFileState";

const basenameOf = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;

export function FileLocateDialogHost() {
  const request = useFileLocateDialogStore((state) => state.request);
  const close = useFileLocateDialogStore((state) => state.close);
  const { config } = useMeshLayout();
  const identities = useAtomValue(environmentSummaries.identitiesAtom);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const labelOf = (environmentId: EnvironmentId) =>
    identities.find((identity) => identity.environmentId === environmentId)?.label ??
    String(environmentId);
  const machineOf = (environmentId: EnvironmentId) =>
    machineDisplayOf(config ?? { machines: {} }, environmentId, labelOf(environmentId));

  if (request === null) return null;
  const { result } = request;
  const threadMachine = machineOf(result.environmentId);
  const candidates = result.candidates ?? (result.target === undefined ? [] : [result.target]);
  const mixedMachines = new Set(candidates.map((candidate) => candidate.environmentId)).size > 1;

  if (result.status !== "choose") {
    const checked = [
      ...new Set([
        result.environmentId,
        ...result.tried.flatMap((entry) =>
          entry.environmentId === undefined ? [] : [entry.environmentId],
        ),
      ]),
    ].map((environmentId) => machineOf(environmentId).tag || machineOf(environmentId).label);
    const project = result.projectTitle ?? threadMachine.label;
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>File not found</DialogTitle>
            <DialogDescription>
              Couldn&apos;t find <code className="rounded bg-muted px-1">{request.rawPath}</code> in{" "}
              {project}
              {checked.length > 0 ? ` (checked ${checked.join(", ")})` : ""}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    request.search(basenameOf(request.rawPath));
                    close();
                  }}
                >
                  Search in project
                </Button>
                <Button
                  variant="outline"
                  disabled={result.cwd === undefined}
                  onClick={() => {
                    if (result.cwd === undefined) return;
                    request.openTarget({
                      environmentId: result.environmentId,
                      absolutePath: result.cwd,
                    });
                    close();
                  }}
                >
                  Open folder
                </Button>
              </div>
              <button
                type="button"
                className="flex items-center gap-1 self-start text-xs text-muted-foreground"
                onClick={() => setDetailsOpen((open) => !open)}
              >
                <ChevronDownIcon
                  className={cn("size-3 transition-transform", detailsOpen && "rotate-180")}
                />
                Details
              </button>
              {detailsOpen ? (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs text-muted-foreground">
                  {result.tried
                    .map(
                      (entry) =>
                        `${entry.tier}${entry.environmentId === undefined ? "" : ` · ${machineOf(entry.environmentId).tag}`}${entry.detail === undefined ? "" : ` · ${entry.detail}`}`,
                    )
                    .join("\n") || "No place was searched."}
                </pre>
              ) : null}
            </div>
          </DialogPanel>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Which file?</DialogTitle>
          <DialogDescription>
            Several files match <code className="rounded bg-muted px-1">{request.rawPath}</code>.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex max-h-[60vh] flex-col gap-1 overflow-auto">
            {candidates.map((candidate, index) => {
              const machine = machineOf(candidate.environmentId);
              const otherMachine = candidate.environmentId !== result.environmentId;
              const best = index === 0;
              return (
                <button
                  key={`${candidate.environmentId}:${candidate.absolutePath}`}
                  type="button"
                  aria-current={best ? "true" : undefined}
                  className={cn(
                    "flex flex-col gap-0.5 rounded border px-2 py-1.5 text-left hover:bg-accent",
                    best ? "border-ring bg-accent/40" : "border-transparent",
                  )}
                  onClick={() => {
                    request.openTarget({
                      environmentId: candidate.environmentId,
                      absolutePath: candidate.absolutePath,
                      ...(candidate.line === undefined ? {} : { line: candidate.line }),
                      ...(candidate.root === undefined ? {} : { root: candidate.root }),
                    });
                    close();
                  }}
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs">{candidate.displayPath}</span>
                    {best ? (
                      <span className="shrink-0 rounded bg-primary px-1 text-3xs text-primary-foreground">
                        Best match
                      </span>
                    ) : null}
                    {mixedMachines || otherMachine || candidate.notSynced ? (
                      <span className="shrink-0 rounded bg-muted px-1 text-3xs uppercase text-muted-foreground">
                        {machine.tag || machine.label}
                        {candidate.notSynced ? " · not synced" : ""}
                      </span>
                    ) : null}
                    {candidate.touchedByThread ? (
                      <span className="shrink-0 rounded bg-accent px-1 text-3xs">
                        edited in this thread
                      </span>
                    ) : null}
                  </span>
                  <span className="text-2xs text-muted-foreground">
                    {candidate.mtimeMs === undefined
                      ? "No modification time"
                      : `${formatRelativeTimeLabel(new Date(candidate.mtimeMs).toISOString())}${otherMachine ? ` · ${machine.label}` : ""}`}
                  </span>
                </button>
              );
            })}
          </div>
        </DialogPanel>
      </DialogContent>
    </Dialog>
  );
}

export function showFileLocateDialog(
  rawPath: string,
  result: FilesLocateResult,
  openTarget: (target: {
    environmentId: EnvironmentId;
    absolutePath: string;
    line?: number;
    root?: string;
  }) => void,
  search: (term: string) => void,
) {
  useFileLocateDialogStore.getState().show({ rawPath, result, openTarget, search });
}
