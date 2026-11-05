import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useEnvironments } from "../../state/environments";
import { MachinePickerGroups } from "./MachinePickerGroups";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { useAtomValue } from "@effect/atom-react";
import { replicaStatusCopy } from "@t3tools/client-runtime/state/mesh-layout";
import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ThreadForkCatalog,
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useRef, useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { AppText } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentServerConfig, useServerConfigs } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { ThreadSettingsInlinePicker } from "../threads/ThreadSettingsSheet";
import { useSidebarWorkspaces } from "./useSidebarWorkspaces";
import { forkingThread } from "./forkThreadState";

export function ForkThreadSheet() {
  const insets = useSafeAreaInsets();
  const thread = useAtomValue(forkingThread);
  const [showDetails, setShowDetails] = useState(false);
  const { config } = useSidebarWorkspaces();
  const serverConfigs = useServerConfigs();
  const { environments } = useEnvironments();
  const connected = new Set(
    environments
      .filter((environment) => environment.connection.phase === "connected")
      .map((environment) => String(environment.environmentId)),
  );
  const fork = useAtomCommand(threadEnvironment.fork, { reportFailure: false });
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
  const [target, setTarget] = useState<EnvironmentId | null>(null);
  const [chosen, setChosen] = useState<ModelSelection | null>(null);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cachedConfig = useEnvironmentServerConfig(target);
  const targetConfig = target && connected.has(target) ? cachedConfig : null;
  const catalog = target === null ? undefined : catalogs[target];
  const sourceConfig = config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG;
  const models = buildModelOptions(
    targetConfig ?? catalog?.value,
    thread?.modelSelection ?? null,
    undefined,
    (thread?.projectId as ProjectId | undefined) ?? null,
  ).filter((model) => !model.isUnavailable);
  const selection =
    chosen ??
    models.find(
      (model) =>
        model.selection.instanceId === thread?.modelSelection.instanceId &&
        model.selection.model === thread?.modelSelection.model,
    )?.selection ??
    models[0]?.selection ??
    null;
  const close = () => {
    appAtomRegistry.set(forkingThread, null);
    setTarget(null);
    setChosen(null);
    setTitle("");
    setMessage("");
    setError(null);
    setCatalogs({});
  };
  if (!thread) return null;
  const selectTarget = (environmentId: EnvironmentId) => {
    setTarget(environmentId);
    setChosen(null);
    if (connected.has(environmentId)) return;
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
      environmentId: thread.environmentId,
      input: { targetEnvironmentId: environmentId },
    })
      .then((result) =>
        result._tag === "Success"
          ? complete({ value: result.value })
          : complete({ error: String(Cause.squash(result.cause)) }),
      )
      .catch((error: unknown) =>
        complete({ error: error instanceof Error ? error.message : String(error) }),
      );
  };
  const label = (environmentId: string) =>
    machineDisplayOf(sourceConfig, environmentId, environmentId).label;
  const machineIds = new Set<string>([
    ...Object.keys(sourceConfig.machines ?? {}),
    ...serverConfigs.keys(),
    thread.environmentId,
  ]);
  if (target === null)
    return (
      <Sheet title="Fork to machine…" onClose={close}>
        <ScrollView>
          <MachinePickerGroups
            machines={[...machineIds]}
            available={(environmentId) => connected.has(environmentId)}
          >
            {(environmentId) => (
              <Pressable
                key={environmentId}
                accessibilityRole="button"
                className="p-4"
                onPress={() => selectTarget(environmentId as EnvironmentId)}
              >
                <AppText>{label(environmentId)}</AppText>
                {catalogs[environmentId]?.error ? (
                  <AppText className="text-xs text-foreground-muted">Unavailable</AppText>
                ) : null}
              </Pressable>
            )}
          </MachinePickerGroups>
        </ScrollView>
      </Sheet>
    );
  const targetTitle = label(target);
  const unavailableDetails =
    (targetConfig ?? catalog?.value)?.providers
      .filter((provider) => provider.enabled && provider.message)
      .slice(0, 2)
      .map((provider) => provider.message) ?? [];
  const online = connected.has(target) || catalog?.value !== undefined;
  const loadingModels =
    !connected.has(target) && catalog !== undefined && !catalog.value && !catalog.error;
  const logicalKey = Object.keys(sourceConfig.projectMounts).find((key) =>
    sourceConfig.projectMounts[key]?.some(
      (rep) => rep.environmentId === thread.environmentId && rep.projectId === thread.projectId,
    ),
  );
  const status = logicalKey ? sourceConfig.projectMountStatus[logicalKey]?.[target] : undefined;
  const progress = status
    ? replicaStatusCopy({
        state: status.state,
        progress: null,
        conflicts: status.conflicts ?? 0,
        message: status.message ?? null,
        targetLabel: targetTitle,
        sourceLabel: label(thread.environmentId),
      })
    : null;
  const catalogError = !connected.has(target) ? catalog?.error : undefined;
  return (
    <Sheet title={`Fork to ${targetTitle}`} onClose={close}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 16 }}
      >
        <AppText className="text-foreground-muted">
          Copies the conversation through its last completed turn. The original stays here.
        </AppText>
        {target ? (
          <AppText role="status">
            {progress === "Synced" || (!progress && target === thread.environmentId)
              ? `Project synced on ${targetTitle}`
              : (progress ?? `Preparing project on ${targetTitle}`)}
          </AppText>
        ) : null}
        {loadingModels ? <AppText role="status">Loading models on {targetTitle}…</AppText> : null}
        {catalogError || (online && models.length === 0) ? (
          <View className="gap-2">
            <AppText className="text-danger-foreground">
              {catalogError
                ? `Could not load models on ${targetTitle}.`
                : `No models are available on ${targetTitle}.`}
            </AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showDetails }}
              onPress={() => setShowDetails(!showDetails)}
            >
              <AppText>Details</AppText>
            </Pressable>
            {showDetails ? (
              <AppText>
                {catalogError ||
                  unavailableDetails.join("\n") ||
                  "Enable and authenticate a provider on this machine."}
              </AppText>
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                close();
                rootNavigationRef.navigate("Settings");
              }}
            >
              <AppText>Open provider settings</AppText>
            </Pressable>
          </View>
        ) : online && selection ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Fork model"
            onPress={() => setPicker(true)}
            className="min-h-[45px] flex-row items-center justify-between gap-3"
          >
            <AppText>Model</AppText>
            <AppText numberOfLines={1} className="min-w-0 shrink">
              {models.find((m) => m.selection.model === selection?.model)?.label ?? "None"}
            </AppText>
          </Pressable>
        ) : null}
        <TextInput
          accessibilityLabel="Fork title"
          className="rounded border border-border p-3 text-foreground"
          placeholder={`${thread.title} (fork)`}
          value={title}
          onChangeText={setTitle}
        />
        <TextInput
          accessibilityLabel="Fork first message"
          className="rounded border border-border p-3 text-foreground"
          placeholder="First message (optional)"
          value={message}
          onChangeText={setMessage}
        />
        {busy ? <AppText role="status">{"Copying the conversation…"}</AppText> : null}
        {error ? <AppText className="text-danger-foreground">{error}</AppText> : null}
        <Button
          tone="primary"
          label={busy ? "Forking…" : `Fork to ${targetTitle}`}
          accessibilityLabel="Confirm fork"
          disabled={busy || !selection || !online}
          onPress={() => {
            if (!selection) return;
            setBusy(true);
            setError(null);
            void fork({
              environmentId: thread.environmentId,
              input: {
                threadId: thread.id,
                targetEnvironmentId: target,
                modelSelection: selection,
                title: title.trim() || `${thread.title} (fork)`,
                ...(message.trim() ? { message } : {}),
              },
            })
              .then((result) => {
                setBusy(false);
                if (result._tag === "Failure") {
                  setError(String(Cause.squash(result.cause)));
                  return;
                }
                close();
              })
              .catch((cause) => {
                setBusy(false);
                Dialog.alert("Could not fork thread", String(cause));
              });
          }}
        />
      </ScrollView>
      <Modal visible={picker} onRequestClose={() => setPicker(false)}>
        <ThreadSettingsInlinePicker
          environmentId={target}
          projectId={thread.projectId}
          hideRuntimeMode
          providerGroups={groupByProvider(models)}
          selectedModel={selection}
          prompt=""
          onPromptChange={() => undefined}
          onSelectModel={(model) => setChosen(model.selection)}
          optionDescriptors={resolveProviderOptionDescriptors({
            capabilities: models.find((m) => m.selection.model === selection?.model)?.capabilities,
            selections: selection?.options,
          })}
          onUpdateOptionSelections={(options) => {
            if (selection) setChosen({ ...selection, options });
          }}
          runtimeMode={thread.runtimeMode}
          onUpdateRuntimeMode={() => undefined}
          onClose={() => setPicker(false)}
        />
      </Modal>
    </Sheet>
  );
}
