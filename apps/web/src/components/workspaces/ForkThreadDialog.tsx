import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import { Combobox, ComboboxInput, ComboboxPopup, ComboboxList, ComboboxItem } from "../ui/combobox";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ThreadId,
  ThreadForkCatalog,
} from "@t3tools/contracts";
import { hasUsableDraftModels, replicaStatusCopy } from "@t3tools/client-runtime/state/mesh-layout";
import { defaultForkTarget } from "@t3tools/client-runtime/state/thread-forks";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useRef, useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { plainErrorMessage } from "@t3tools/client-runtime/errors";
import { useMeshLayout } from "../../hooks/useMeshLayout";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  providerInstanceEntriesFor,
  isProviderInstancePickerReady,
} from "../../providerInstances";
import { readThreadShell, useServerConfigs } from "../../state/entities";
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
  const display = machineDisplayOf({ machines: config?.machines ?? {} }, environmentId, fallback);
  return { label: display.label, title: display.label };
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
  const serverConfigs = useServerConfigs();
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
        "Unnamed machine",
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

  const config = mesh.config;
  const logicalKey = Object.keys(config?.projectMounts ?? {}).find((key) =>
    config?.projectMounts[key]?.some(
      (rep) =>
        rep.environmentId === source.environmentId && rep.projectId === source.shell?.projectId,
    ),
  );
  // Never default to the machine the thread already runs on when another can take it,
  // and prefer one the shared draft resolver says can run a model for this project.
  const defaultTarget = defaultForkTarget({
    sourceEnvironmentId: source.environmentId as string,
    candidates: environments.map((entry) => {
      const projectId =
        config?.projectMounts[logicalKey ?? ""]?.find(
          (rep) => rep.environmentId === entry.environmentId,
        )?.projectId ?? null;
      const serverConfig = serverConfigs.get(entry.environmentId);
      const providers = providersByEnvironment.get(entry.environmentId) ?? [];
      const catalog =
        serverConfig || providers.length > 0
          ? {
              providers,
              ...(serverConfig
                ? {
                    settings: serverConfig.settings,
                    ...(serverConfig.managedPolicy
                      ? { managedPolicy: serverConfig.managedPolicy }
                      : {}),
                  }
                : {}),
            }
          : null;
      return {
        environmentId: entry.environmentId,
        connected: entry.connection.phase === "connected",
        hasUsableModel: hasUsableDraftModels(catalog, projectId as ProjectId | null),
      };
    }),
  }) as EnvironmentId;
  const target = targetEnvironmentId ?? defaultTarget;
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
        ? `Couldn't load models on ${displayMachine(target).title}. Try again.`
        : !online
          ? `Choose a machine to load its models.`
          : choices.length === 0
            ? `No models are available on ${displayMachine(target).title}. Set one up there first.`
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
          : complete({ error: plainErrorMessage(squashAtomCommandFailure(result)) }),
      )
      .catch((error: unknown) => complete({ error: plainErrorMessage(error) }));
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
              <Combobox
                items={machines}
                value={machines.find((machine) => machine.environmentId === target) ?? null}
                itemToStringLabel={(machine) => machine.title}
                onValueChange={(machine) => {
                  if (machine) selectTarget(machine.environmentId);
                }}
              >
                <ComboboxInput aria-label="Fork target machine" />
                <ComboboxPopup>
                  <ComboboxList>
                    {(machine: (typeof machines)[number]) => (
                      <ComboboxItem
                        key={machine.environmentId}
                        value={machine}
                        disabled={machine.unavailable}
                      >
                        {machine.title}
                        {machine.unavailable ? " (unavailable)" : ""}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxPopup>
              </Combobox>
            </label>
            <p className="text-sm text-muted-foreground">
              Copies the conversation through its last completed turn. The original stays where it
              is and keeps running.
            </p>
            {target ? (
              <p role="status" className="text-sm text-muted-foreground">
                {syncCopy === "Synced" || (!syncCopy && target === source.environmentId)
                  ? `Project synced on ${displayMachine(target).title}`
                  : (syncCopy ?? `Preparing project on ${displayMachine(target).title}`)}
              </p>
            ) : null}
            {loadingModels ? (
              <p role="status">Loading models on {displayMachine(target).title}…</p>
            ) : null}
            {noModelsReason ? (
              <p role="status" className="text-sm text-destructive">
                {noModelsReason}
              </p>
            ) : initial && selectedEntry ? (
              <div className="flex min-h-10 items-center justify-between gap-3">
                <span className="text-sm">Model</span>
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
                        allowPromptInjectedEffort: false,
                        onModelOptionsChange: (options) =>
                          setChosen({ ...initial, options: options ?? [] }),
                      }}
                    />
                  }
                />
              </div>
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
