import { useEffect, useState, useSyncExternalStore } from "react";
import { MeshConfigRevision, type EnvironmentId } from "@t3tools/contracts";
import { MeshConfigEditor } from "@t3tools/client-runtime/state/mesh-layout-client";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useMeshLayout } from "../../hooks/useMeshLayout";
import { meshLayoutAtoms } from "../../state/meshLayout";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel } from "../ui/dialog";

const isRevision = Schema.is(MeshConfigRevision);

export function MeshConfigDialog({
  environmentId,
  onClose,
}: {
  environmentId: EnvironmentId;
  onClose: () => void;
}) {
  const mesh = useMeshLayout();
  const get = useAtomCommand(meshLayoutAtoms.configGet, { reportFailure: false });
  const plan = useAtomCommand(meshLayoutAtoms.configPlan, { reportFailure: false });
  const apply = useAtomCommand(meshLayoutAtoms.configApply, { reportFailure: false });
  const [editor] = useState(
    () =>
      new MeshConfigEditor({
        get: async () => {
          const result = await get({ environmentId, input: {} });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
        plan: async (doc) => {
          const result = await plan({ environmentId, input: { doc } });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
        apply: async (doc, baseRevision) => {
          const result = await apply({ environmentId, input: { doc, baseRevision } });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
      }),
  );
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Loads the server configuration when the editor opens.
  useEffect(() => {
    void editor.load();
  }, [editor]);
  const history = Object.entries(mesh.state.snapshot?.document ?? {})
    .flatMap(([key, entry]) =>
      key.startsWith("mesh.configHistory/") && isRevision(entry.v) ? [entry.v] : [],
    )
    .sort((a, b) => b.writtenAt.localeCompare(a.writtenAt));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !state.busy) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Mesh config</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <div className="flex max-h-96 overflow-auto rounded border border-border font-mono text-xs leading-5">
              <pre
                aria-hidden="true"
                className="select-none bg-muted px-2 py-2 text-muted-foreground"
              >
                {state.text
                  .split("\n")
                  .map((_, i) => i + 1)
                  .join("\n")}
              </pre>
              <textarea
                aria-label="Mesh YAML"
                disabled={state.busy}
                aria-invalid={state.error !== null}
                aria-describedby="mesh-config-errors"
                spellCheck={false}
                className="min-h-72 min-w-0 flex-1 resize-y bg-background p-2 outline-none"
                value={state.text}
                onChange={(event) => editor.edit(event.target.value)}
              />
            </div>
            {state.error ? (
              <pre
                id="mesh-config-errors"
                role="alert"
                className="whitespace-pre-wrap text-xs text-destructive"
              >
                {state.error}
              </pre>
            ) : null}
            {state.stale ? (
              <div>
                <pre className="whitespace-pre-wrap text-xs">
                  {JSON.stringify(state.stale.diff, null, 2)}
                </pre>
                <Button onClick={() => void editor.rebase()} disabled={state.busy}>
                  Reload and reapply
                </Button>
              </div>
            ) : null}
            {state.actions ? (
              <ul aria-label="Config plan">
                {state.actions.length ? (
                  state.actions.map((action) => <li key={action.id}>{action.description}</li>)
                ) : (
                  <li>No changes needed.</li>
                )}
              </ul>
            ) : null}
            <div className="flex gap-2">
              <Button variant="outline" disabled={state.busy} onClick={() => void editor.plan()}>
                Plan
              </Button>
              <Button
                disabled={state.busy || state.actions === null}
                onClick={() => void editor.apply()}
              >
                Apply
              </Button>
            </div>
            <details>
              <summary>History</summary>
              {history.map((revision) => (
                <div
                  key={revision.revision}
                  className="flex items-center justify-between gap-2 py-2"
                >
                  <span>
                    {revision.writtenAt} · {revision.author}
                  </span>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={state.busy}
                    onClick={() => editor.restore(revision)}
                  >
                    Restore {revision.revision}
                  </Button>
                </div>
              ))}
            </details>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
