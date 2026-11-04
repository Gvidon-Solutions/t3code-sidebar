import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ModelSelection,
  ThreadId,
  ThreadForkCatalog,
} from "@t3tools/contracts";
import { replicaStatusCopy } from "@t3tools/client-runtime/state/mesh-layout";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useRef, useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { useMeshLayout } from "../../hooks/useMeshLayout";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  providerInstanceEntriesFor,
  isProviderInstancePickerReady,
} from "../../providerInstances";
import { readThreadShell } from "../../state/entities";
import { useEnvironments, useEnvironmentProviders } from "../../state/environments";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ComposerEffortColumn } from "../chat/ComposerModelEffort";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { closeForkThread, forkingThread, type ForkThreadRequest } from "./forkThreadState";

function machineLabel(
  config: ReturnType<typeof useMeshLayout>["config"],
  environmentId: string,
  fallback: string,
): { label: string; title: string } {
  const machine = config?.machines[environmentId];
  return {
    label: machine?.label ?? machine?.tag ?? fallback,
    title: machine?.title ?? machine?.label ?? machine?.tag ?? fallback,
  };
}

export function ForkThreadDialogHost() {
  const request = useAtomValue(forkingThread);
  return request ? <ForkThreadDialog request={request} onClose={closeForkThread} /> : null;
}

export function ForkThreadDialog(props: {
  readonly request: ForkThreadRequest;
  readonly onClose: () => void;
}) {
  const { request } = props;
  const mesh = useMeshLayout();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const forkCommand = useAtomCommand(threadEnvironment.fork, { reportFailure: false });
  const loadCatalog = useAtomCommand(threadEnvironment.forkCatalog, { reportFailure: false });
  const catalogRequest = useRef(0);
  const [catalogs, setCatalogs] = useState<
    Record<
      string,
      {
        request: number;
        value?: ThreadForkCatalog;
        error?: string;
      }
    >
  >({});

  const displayMachine = (environmentId: string) =>
    machineLabel(
      mesh.config,
      environmentId,
      environments.find((environment) => environment.environmentId === environmentId)?.label ??
        "Unknown machine",
    );
  const source = {
    shell: readThreadShell(scopeThreadRef(request.environmentId, request.threadId)),
    environmentId: request.environmentId,
    threadId: request.threadId,
  };
  const [targetEnvironmentId, setTargetEnvironmentId] = useState<EnvironmentId | null>(null);
  const [chosen, setChosen] = useState<ModelSelection | null>(null);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = targetEnvironmentId ?? source.environmentId;
  const connected = environments.some(
    (entry) => entry.environmentId === target && entry.connection.phase === "connected",
  );
  const catalog = catalogs[target];
  const targetSettings = useEnvironmentSettings(target);
  const providers = connected
    ? (providersByEnvironment.get(target) ?? [])
    : (catalog?.value?.providers ?? []);
  const projectId = source.shell?.projectId ?? null;
  const entries =
    target && projectId
      ? (connected
          ? providerInstanceEntriesFor(providers, targetSettings, projectId)
          : deriveProviderInstanceEntries(providers)
        ).filter(isProviderInstancePickerReady)
      : [];
  const options = connected
    ? getCustomModelOptionsByInstance(targetSettings, providers)
    : new Map(providers.map((provider) => [provider.instanceId, provider.models]));
  const choices = entries.flatMap((entry) =>
    entry.models.map((model) => ({
      selection: { instanceId: entry.instanceId, model: model.slug } as ModelSelection,
      isDefault: model.isDefault ?? false,
    })),
  );
  const initial =
    chosen ??
    choices.find(
      (choice) =>
        choice.selection.instanceId === source.shell?.modelSelection.instanceId &&
        choice.selection.model === source.shell?.modelSelection.model,
    )?.selection ??
    choices.find((choice) => choice.isDefault)?.selection ??
    choices[0]?.selection ??
    null;
  const selectedEntry = entries.find((entry) => entry.instanceId === initial?.instanceId);
  const online = connected || catalog?.value !== undefined;
  const loadingModels = !connected && catalog !== undefined && !catalog.value && !catalog.error;
  const config = mesh.config;
  const logicalKey = Object.keys(config?.projectMounts ?? {}).find((key) =>
    config?.projectMounts[key]?.some(
      (rep) =>
        rep.environmentId === source.environmentId && rep.projectId === source.shell?.projectId,
    ),
  );
  const syncStatus = logicalKey && target ? config?.projectMountStatus[logicalKey]?.[target] : null;
  const syncCopy = syncStatus
    ? replicaStatusCopy({
        state: syncStatus.state,
        progress: null,
        conflicts: syncStatus.conflicts ?? 0,
        message: syncStatus.message ?? null,
        targetLabel: target ? displayMachine(target).title : "the target",
        sourceLabel: displayMachine(source.environmentId).title,
      })
    : null;
  const forkTitle = title.trim() || `${source.shell?.title ?? "Thread"} (fork)`;
  const noModelsReason = !target
    ? null
    : loadingModels
      ? null
      : !connected && catalog?.error
        ? `Could not load models on ${displayMachine(target).title}: ${catalog.error}`
        : !online
          ? `Choose a machine to load its models.`
          : choices.length === 0
            ? [
                `No models are available on ${displayMachine(target).title}.`,
                ...providers
                  .filter((provider) => provider.enabled && provider.message)
                  .slice(0, 2)
                  .map((provider) => provider.message),
              ].join(" ")
            : null;

  if (!source.shell) return null;

  const close = () => {
    props.onClose();
    setTargetEnvironmentId(null);
    setChosen(null);
    setTitle("");
    setMessage("");
    setError(null);
    setCatalogs({});
  };
  const selectTarget = (environmentId: EnvironmentId) => {
    setTargetEnvironmentId(environmentId);
    setChosen(null);
    if (
      environments.some(
        (entry) => entry.environmentId === environmentId && entry.connection.phase === "connected",
      )
    )
      return;
    const request = ++catalogRequest.current;
    setCatalogs((current) => ({ ...current, [environmentId]: { request } }));
    const complete = (value: { value: ThreadForkCatalog } | { error: string }) => {
      setCatalogs((current) =>
        current[environmentId]?.request === request
          ? { ...current, [environmentId]: { request, ...value } }
          : current,
      );
    };
    void loadCatalog({
      environmentId: source.environmentId,
      input: { targetEnvironmentId: environmentId },
    })
      .then((result) =>
        result._tag === "Success"
          ? complete({ value: result.value })
          : complete({ error: String(squashAtomCommandFailure(result)) }),
      )
      .catch((error: unknown) =>
        complete({ error: error instanceof Error ? error.message : String(error) }),
      );
  };
  const machineIds = new Set<string>([
    ...Object.keys(config?.machines ?? {}),
    ...environments.map((environment) => environment.environmentId),
    ...(target ? [target] : []),
    source.environmentId,
  ]);
  const machines = [...machineIds].map((environmentId) => {
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    return {
      environmentId: environmentId as EnvironmentId,
      ...displayMachine(environmentId),
      online:
        environment?.connection.phase === "connected" ||
        catalogs[environmentId]?.value !== undefined,
      unavailable: catalogs[environmentId]?.error !== undefined,
    };
  });

  const submit = async () => {
    if (!target || !initial) return;
    setBusy(true);
    setError(null);
    const result = await forkCommand({
      environmentId: source.environmentId,
      input: {
        threadId: source.threadId as ThreadId,
        targetEnvironmentId: target,
        modelSelection: initial,
        title: forkTitle,
        ...(message.trim() ? { message } : {}),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return;
    }
    toastManager.add({
      title: "Forked",
      description: `${forkTitle} on ${displayMachine(target).title}`,
    });
    close();
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? close() : undefined)}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Fork to {target ? displayMachine(target).title : "a machine"}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <label className="block text-sm">
              Machine
              <select
                aria-label="Fork target machine"
                className="mt-1 w-full rounded border border-border bg-background p-2"
                value={target ?? ""}
                onChange={(event) => {
                  selectTarget(event.currentTarget.value as EnvironmentId);
                }}
              >
                {machines.map((machine) => (
                  <option key={machine.environmentId} value={machine.environmentId}>
                    {machine.title} {machine.title !== machine.label ? `(${machine.label})` : ""}
                    {machine.unavailable ? " (unavailable)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-sm text-muted-foreground">
              Copies the conversation through its last completed turn. The original stays where it
              is and keeps running.
            </p>
            {syncCopy ? <p className="text-sm text-muted-foreground">{syncCopy}</p> : null}
            {loadingModels ? (
              <p role="status">Loading models on {displayMachine(target).title}…</p>
            ) : null}
            {noModelsReason ? (
              <p className="text-sm text-destructive">{noModelsReason}</p>
            ) : initial && selectedEntry ? (
              <ProviderModelPicker
                environmentId={target!}
                activeInstanceId={initial.instanceId}
                model={initial.model}
                lockedProvider={null}
                instanceEntries={entries}
                modelOptionsByInstance={options}
                triggerAriaLabel="Fork model"
                onInstanceModelChange={(instanceId, model) => setChosen({ instanceId, model })}
                effortColumn={
                  <ComposerEffortColumn
                    traits={{
                      provider: selectedEntry.driverKind,
                      instanceId: initial.instanceId,
                      models: selectedEntry.models,
                      model: initial.model,
                      modelOptions: initial.options ?? [],
                      planModeEnabled: false,
                      allowPromptInjectedEffort: false,
                      onModelOptionsChange: (options) =>
                        setChosen({ ...initial, options: options ?? [] }),
                    }}
                  />
                }
              />
            ) : null}
            <label className="block text-sm">
              Title
              <input
                aria-label="Fork title"
                className="mt-1 w-full rounded border border-border bg-background p-2"
                value={title}
                placeholder={`${source.shell.title} (fork)`}
                onChange={(event) => setTitle(event.currentTarget.value)}
              />
            </label>
            <label className="block text-sm">
              First message (optional)
              <textarea
                aria-label="Fork first message"
                className="mt-1 w-full rounded border border-border bg-background p-2"
                rows={3}
                value={message}
                onChange={(event) => setMessage(event.currentTarget.value)}
              />
            </label>
            {busy ? (
              <p role="status" className="text-sm text-muted-foreground">
                Preparing {mesh.config?.projectTitles[logicalKey ?? ""] ?? "the project"} on{" "}
                {target ? displayMachine(target).title : "the machine"} and copying the
                conversation…
              </p>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button
                disabled={busy || !target || !initial || noModelsReason !== null}
                onClick={() => void submit()}
              >
                {busy ? "Forking…" : `Fork to ${target ? displayMachine(target).title : ""}`}
              </Button>
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
