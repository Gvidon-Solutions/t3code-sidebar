import { useAtomValue } from "@effect/atom-react";
import { replicaStatusCopy } from "@t3tools/client-runtime/state/mesh-layout";
import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

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
  const thread = useAtomValue(forkingThread);
  const { config } = useSidebarWorkspaces();
  const serverConfigs = useServerConfigs();
  const fork = useAtomCommand(threadEnvironment.fork, { reportFailure: false });
  const [target, setTarget] = useState<EnvironmentId | null>(null);
  const [chosen, setChosen] = useState<ModelSelection | null>(null);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetConfig = useEnvironmentServerConfig(target);
  const sourceConfig = config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG;
  const models = buildModelOptions(
    targetConfig,
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
  };
  if (!thread) return null;
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
          {[...machineIds].map((environmentId) => (
            <Pressable
              key={environmentId}
              accessibilityRole="button"
              className="p-4"
              onPress={() => setTarget(environmentId as EnvironmentId)}
            >
              <AppText>
                {sourceConfig.machines[environmentId]?.title ?? label(environmentId)} (
                {label(environmentId)})
              </AppText>
              {!serverConfigs.has(environmentId as EnvironmentId) ? (
                <AppText className="text-xs text-muted-foreground">Offline</AppText>
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      </Sheet>
    );
  const targetTitle = sourceConfig.machines[target]?.title ?? label(target);
  const online = serverConfigs.has(target);
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
        sourceLabel:
          sourceConfig.machines[thread.environmentId]?.title ?? label(thread.environmentId),
      })
    : null;
  return (
    <Sheet title={`Fork to ${targetTitle}`} onClose={close}>
      <View className="gap-4 p-4">
        <AppText className="text-muted-foreground">
          Copies the conversation through its last completed turn. The original stays here.
        </AppText>
        {!online ? <AppText className="text-destructive">{targetTitle} is offline.</AppText> : null}
        {online && models.length === 0 ? (
          <AppText className="text-destructive">No models are available on {targetTitle}.</AppText>
        ) : (
          <Pressable accessibilityRole="button" onPress={() => setPicker(true)}>
            <AppText>
              Model: {models.find((m) => m.selection.model === selection?.model)?.label ?? "None"}
            </AppText>
          </Pressable>
        )}
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
        {busy ? (
          <AppText role="status">
            {progress ?? "Preparing the project and copying the conversation…"}
          </AppText>
        ) : null}
        {error ? <AppText className="text-destructive">{error}</AppText> : null}
        <Pressable
          accessibilityRole="button"
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
        >
          <AppText>{busy ? "Forking…" : `Fork to ${targetTitle}`}</AppText>
        </Pressable>
      </View>
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
