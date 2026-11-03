import { useState } from "react";
import { Modal, Pressable, View } from "react-native";
import type { EnvironmentId, ModelSelection, ProjectId, RuntimeMode } from "@t3tools/contracts";
import { resolveMoveModel } from "@t3tools/client-runtime/state/mesh-layout";
import { useEnvironmentServerConfig } from "../../state/entities";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { AppText } from "../../components/ui/AppText";
import { Sheet } from "../../components/ui/Sheet";
import { ThreadSettingsInlinePicker } from "../threads/ThreadSettingsSheet";

export function MoveThreadTargetModel(props: {
  readonly target: { readonly environmentId: EnvironmentId; readonly id: ProjectId };
  readonly current: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly machine: string;
  readonly crossMachine: boolean;
  readonly copyHere?: { readonly label: string; readonly run: () => Promise<void> } | undefined;
  readonly onMove: (selection: ModelSelection) => void;
  readonly onClose: () => void;
}) {
  const config = useEnvironmentServerConfig(props.target.environmentId);
  const models = buildModelOptions(config, null, undefined, props.target.id).filter(
    (model) => !model.isUnavailable,
  );
  const initial = resolveMoveModel(
    props.current,
    models,
    config?.settings.projectSettingsOverrides[props.target.id]?.defaultModelSelection ??
      config?.settings.defaultModelSelection,
  );
  const [copying, setCopying] = useState(false);
  const [chosen, setChosen] = useState<ModelSelection | null>(null);
  const [picker, setPicker] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [runtimeMode, setRuntimeMode] = useState(props.runtimeMode);
  const selection = chosen ?? initial.selection;
  const selected = models.find(
    (model) =>
      model.selection.instanceId === selection?.instanceId &&
      model.selection.model === selection.model,
  );
  return (
    <Sheet title={`Move to ${props.machine}?`} onClose={props.onClose}>
      <View className="gap-4 p-4">
        {props.crossMachine ? (
          <AppText>The conversation continues there; this thread is archived.</AppText>
        ) : null}
        {initial.fallback && selection ? (
          <AppText>Current model is unavailable here; the target default is selected.</AppText>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Move model"
          onPress={() => setPicker(true)}
        >
          <AppText>Model: {selected?.label ?? "No enabled models"}</AppText>
        </Pressable>
        {props.copyHere ? (
          <Pressable
            accessibilityRole="button"
            disabled={copying}
            onPress={async () => {
              setCopying(true);
              await props.copyHere?.run().finally(() => setCopying(false));
            }}
          >
            <AppText>{copying ? "Preparing copy…" : props.copyHere.label}</AppText>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Confirm move"
          disabled={copying || !selection}
          onPress={() => {
            if (selection) props.onMove(selection);
          }}
        >
          <AppText>{props.crossMachine ? `Move to ${props.machine}` : "Move"}</AppText>
        </Pressable>
      </View>
      <Modal visible={picker} onRequestClose={() => setPicker(false)}>
        <ThreadSettingsInlinePicker
          environmentId={props.target.environmentId}
          projectId={props.target.id}
          hideRuntimeMode
          providerGroups={groupByProvider(models)}
          selectedModel={selection}
          prompt={prompt}
          onPromptChange={setPrompt}
          onSelectModel={(model) => setChosen(model.selection)}
          optionDescriptors={resolveProviderOptionDescriptors({
            capabilities: selected?.capabilities,
            selections: selection?.options,
          })}
          onUpdateOptionSelections={(options) => {
            if (selection) setChosen({ ...selection, options });
          }}
          runtimeMode={runtimeMode}
          onUpdateRuntimeMode={setRuntimeMode}
          onClose={() => setPicker(false)}
        />
      </Modal>
    </Sheet>
  );
}
