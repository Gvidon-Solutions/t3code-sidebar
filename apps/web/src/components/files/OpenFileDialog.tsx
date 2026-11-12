import { useAtomValue } from "@effect/atom-react";
import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useActiveProjectTarget } from "~/hooks/useActiveProjectTarget";
import { useMeshLayout } from "~/hooks/useMeshLayout";
import { MachineTag } from "../workspaces/MachineTag";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProjects } from "~/state/entities";
import { filesEnvironment } from "~/state/files";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";
import { environmentSummaries } from "~/state/presentation";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  fileViewerContext,
  readRecentFiles,
  rememberRecentFile,
  resolveOpenFilePath,
} from "./OpenFileDialog.logic";
import { useOpenFileDialogStore } from "./openFileDialogState";

const LIST_LIMIT = 50;

function OpenFileDialogContent({
  initialEnvironmentId,
  initialPath,
}: {
  initialEnvironmentId: EnvironmentId | null;
  initialPath: string | null;
}) {
  const { config } = useMeshLayout();
  const identities = useAtomValue(environmentSummaries.identitiesAtom).map((identity) => ({
    ...identity,
    ...machineDisplayOf(config ?? { machines: {} }, identity.environmentId, identity.label),
  }));
  const connectedIds = useAtomValue(environmentSummaries.connectedEnvironmentIdsAtom);
  const projects = useProjects();
  const active = useActiveProjectTarget();
  const close = useOpenFileDialogStore((state) => state.close);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId>(
    initialEnvironmentId ??
      active?.environmentId ??
      identities[0]?.environmentId ??
      ("unknown" as EnvironmentId),
  );
  const selectedLabel =
    identities.find((identity) => identity.environmentId === selectedEnvironmentId)?.label ??
    String(selectedEnvironmentId);
  const selectedProjectRoot =
    active !== null && active.environmentId === selectedEnvironmentId
      ? active.cwd
      : (projects.find((project) => project.environmentId === selectedEnvironmentId)
          ?.workspaceRoot ?? null);
  const recents = readRecentFiles(window.localStorage, selectedEnvironmentId);
  const [value, setValue] = useState(
    () => initialPath ?? selectedProjectRoot ?? recents[0] ?? "~/",
  );
  const [error, setError] = useState<string | null>(null);

  const resolved = resolveOpenFilePath({
    value,
    environmentId: selectedEnvironmentId,
    workspaceRoot: selectedProjectRoot,
  });
  const callEnvironmentId = connectedIds.includes(selectedEnvironmentId)
    ? selectedEnvironmentId
    : (connectedIds[0] ?? null);
  const access = useFilesystemReadAccess(callEnvironmentId);
  const listQuery = useEnvironmentQuery(
    access.canReadFiles && callEnvironmentId !== null && resolved !== null
      ? filesEnvironment.list({
          environmentId: callEnvironmentId,
          input: { partialPath: resolved.absolutePath, limit: LIST_LIMIT },
        })
      : null,
  );
  const entries = listQuery.data?.entries ?? [];
  const targetConnected = connectedIds.includes(selectedEnvironmentId);
  const canOpen = active !== null && resolved !== null && targetConnected;

  const openPath = (environmentId: EnvironmentId, absolutePath: string) => {
    const target = fileViewerContext({
      environmentId,
      environmentLabel:
        identities.find((identity) => identity.environmentId === environmentId)?.label ??
        String(environmentId),
      absolutePath,
      projects,
    });
    const threadRef = active?.threadRef ?? null;
    if (threadRef === null) {
      setError("Open a thread to use the file viewer.");
      return;
    }
    rememberRecentFile(window.localStorage, environmentId, absolutePath);
    useRightPanelStore.getState().openFile(threadRef, absolutePath, undefined, target);
    close();
  };

  const open = () => {
    setError(null);
    if (resolved === null) {
      setError("Enter an absolute path or one starting with ~/.");
      return;
    }
    if (!targetConnected) {
      setError(`Not connected to ${selectedLabel}.`);
      return;
    }
    openPath(resolved.environmentId, resolved.absolutePath);
  };

  return (
    <Dialog open onOpenChange={(isOpen) => (!isOpen ? close() : undefined)}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Open file…</DialogTitle>
          <DialogDescription>
            Any file on a connected machine: inside a project or outside one.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Machine</div>
              <div className="flex flex-wrap gap-1.5">
                {identities.map((identity) => {
                  const connected = connectedIds.includes(identity.environmentId);
                  const selected = identity.environmentId === selectedEnvironmentId;
                  return (
                    <Button
                      key={identity.environmentId}
                      type="button"
                      size="xs"
                      variant={selected ? "secondary" : "outline"}
                      aria-pressed={selected}
                      title={
                        connected
                          ? identity.label
                          : `${identity.label}: not connected from this client`
                      }
                      onClick={() => {
                        setSelectedEnvironmentId(identity.environmentId);
                        setValue(
                          identity.environmentId === active?.environmentId && active !== null
                            ? active.cwd
                            : (readRecentFiles(window.localStorage, identity.environmentId)[0] ??
                                "~/"),
                        );
                        setError(null);
                      }}
                    >
                      <MachineTag machine={identity} />
                      <span className={connected ? "" : "text-muted-foreground"}>
                        {identity.label}
                      </span>
                    </Button>
                  );
                })}
              </div>
            </div>

            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                open();
              }}
            >
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                Path
                <Input
                  autoFocus
                  value={value}
                  font="mono"
                  placeholder="/srv/app/README.md or ~/notes.md"
                  onChange={(event) => {
                    setValue(event.currentTarget.value);
                    setError(null);
                  }}
                />
              </label>
              {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
              {entries.length > 0 ? (
                <ul className="max-h-56 overflow-y-auto rounded-md border border-border">
                  {entries.map((entry) => (
                    <li key={entry.absolutePath}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent"
                        onClick={() => {
                          if (entry.kind === "directory") {
                            setValue(`${entry.absolutePath}/`);
                            setError(null);
                            return;
                          }
                          if (!targetConnected) {
                            setError(`Not connected to ${selectedLabel}.`);
                            return;
                          }
                          openPath(selectedEnvironmentId, entry.absolutePath);
                        }}
                      >
                        <span className="truncate font-mono">{entry.name}</span>
                        <span className="text-muted-foreground">
                          {entry.kind === "directory" ? "folder" : entry.kind}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {!targetConnected ? (
                <p className="text-xs text-muted-foreground">
                  Not connected to {selectedLabel}. Connect it in Settings → Connections.
                </p>
              ) : null}
            </form>

            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                Recent on {selectedLabel}
              </div>
              {recents.length === 0 ? (
                <p className="text-xs text-muted-foreground">No files opened here yet.</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {recents.map((file) => (
                    <button
                      key={file}
                      type="button"
                      className="truncate rounded-sm px-1 py-0.5 text-left font-mono text-xs hover:bg-accent"
                      onClick={() => {
                        if (!targetConnected) {
                          setError(`Not connected to ${selectedLabel}.`);
                          return;
                        }
                        openPath(selectedEnvironmentId, file);
                      }}
                    >
                      {file}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button type="button" disabled={!canOpen} onClick={open}>
            Open file
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function OpenFileDialog() {
  const initialPath = useOpenFileDialogStore((state) => state.initialPath);
  const isOpen = useOpenFileDialogStore((state) => state.isOpen);
  const initialEnvironmentId = useOpenFileDialogStore((state) => state.initialEnvironmentId);
  if (!isOpen) return null;
  return (
    <OpenFileDialogContent
      key={initialEnvironmentId === null ? "default" : String(initialEnvironmentId)}
      initialEnvironmentId={initialEnvironmentId}
      initialPath={initialPath}
    />
  );
}
