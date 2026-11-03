import { useState } from "react";
import type { EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";
import { resolveMoveModel } from "@t3tools/client-runtime/state/mesh-layout";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { providerInstanceEntriesFor, isProviderInstancePickerReady } from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ComposerEffortColumn } from "../chat/ComposerModelEffort";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel } from "../ui/dialog";
import { Button } from "../ui/button";

export function MoveThreadModelDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly current: ModelSelection;
  readonly machine: string;
  readonly crossMachine: boolean;
  readonly copyHere?: { readonly label: string; readonly run: () => Promise<void> } | undefined;
  readonly onMove: (selection: ModelSelection) => void;
  readonly onClose: () => void;
}) {
  const settings = useEnvironmentSettings(props.environmentId);
  const providers = useEnvironmentProviders().get(props.environmentId) ?? [];
  const entries = providerInstanceEntriesFor(providers, settings, props.projectId).filter(
    isProviderInstancePickerReady,
  );
  const options = getCustomModelOptionsByInstance(settings, providers);
  const choices = entries.flatMap((entry) =>
    entry.models.map((model) => ({
      selection: { instanceId: entry.instanceId, model: model.slug },
      isDefault: model.isDefault ?? false,
    })),
  );
  const initial = resolveMoveModel(
    props.current,
    choices,
    settings.projectSettingsOverrides[props.projectId]?.defaultModelSelection ??
      settings.defaultModelSelection,
  );
  const [copying, setCopying] = useState(false);
  const [chosen, setChosen] = useState<ModelSelection | null>(null);
  const selection = chosen ?? initial.selection;
  const entry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Move to {props.machine}?</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {props.crossMachine ? (
            <p>The conversation continues there; this thread is archived.</p>
          ) : null}
          {initial.fallback && selection ? (
            <p>Current model is unavailable here; the target default is selected.</p>
          ) : null}
          {selection && entry ? (
            <ProviderModelPicker
              environmentId={props.environmentId}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={options}
              triggerAriaLabel="Move model"
              onInstanceModelChange={(instanceId, model) => setChosen({ instanceId, model })}
              effortColumn={
                <ComposerEffortColumn
                  traits={{
                    provider: entry.driverKind,
                    instanceId: selection.instanceId,
                    models: entry.models,
                    model: selection.model,
                    modelOptions: selection.options,
                    planModeEnabled: false,
                    allowPromptInjectedEffort: false,
                    onModelOptionsChange: (options) =>
                      setChosen({ ...selection, options: options ?? [] }),
                  }}
                />
              }
            />
          ) : (
            <p>No enabled models on this machine.</p>
          )}
          {props.copyHere ? (
            <Button
              variant="outline"
              disabled={copying}
              onClick={async () => {
                setCopying(true);
                await props.copyHere?.run().finally(() => setCopying(false));
              }}
            >
              {copying ? "Preparing copy…" : props.copyHere.label}
            </Button>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              disabled={copying || !selection || !entry}
              onClick={() => {
                if (selection) props.onMove(selection);
              }}
            >
              {props.crossMachine ? `Move to ${props.machine}` : "Move"}
            </Button>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
