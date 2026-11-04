import { useEffect, useState, useSyncExternalStore } from "react";
import { Modal, ScrollView, View, Pressable } from "react-native";
import { MeshConfigRevision, type EnvironmentId } from "@t3tools/contracts";
import { MeshConfigEditor } from "@t3tools/client-runtime/state/mesh-layout-client";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { useMeshLayout } from "../workspaces/useMeshLayout";
import { meshLayoutAtoms } from "../../state/mesh-layout";
import { useAtomCommand } from "../../state/use-atom-command";

const isRevision = Schema.is(MeshConfigRevision);

export function MeshConfigSheet({
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
  const [historyOpen, setHistoryOpen] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Loads the server configuration on opening the native editor.
  useEffect(() => {
    void editor.load();
  }, [editor]);
  const history = Object.entries(mesh.state.snapshot?.document ?? {})
    .flatMap(([key, entry]) =>
      key.startsWith("mesh.configHistory/") && isRevision(entry.v) ? [entry.v] : [],
    )
    .sort((a, b) => b.writtenAt.localeCompare(a.writtenAt));
  return (
    <Modal visible presentationStyle="fullScreen" onRequestClose={onClose}>
      <View className="flex-1 bg-sheet px-5 py-8">
        <ScrollView keyboardShouldPersistTaps="handled">
          <View className="gap-4">
            <AppText className="text-xl font-t3-bold">Mesh config</AppText>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              disabled={state.busy}
              className="min-h-[45px] justify-center"
            >
              <AppText>Close</AppText>
            </Pressable>
            <View className="flex-row rounded border border-border">
              <AppText accessibilityElementsHidden className="px-2 py-3 font-mono text-xs">
                {state.text
                  .split("\n")
                  .map((_, i) => i + 1)
                  .join("\n")}
              </AppText>
              <AppTextInput
                accessibilityLabel="Mesh YAML"
                editable={!state.busy}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                className="min-h-72 flex-1 px-2 py-3 font-mono text-xs text-foreground"
                value={state.text}
                onChangeText={editor.edit}
                style={{ textAlignVertical: "top" }}
              />
            </View>
            {state.error ? (
              <AppText accessibilityRole="alert" className="text-danger-foreground">
                {state.error}
              </AppText>
            ) : null}
            {state.stale ? (
              <>
                <AppText>{JSON.stringify(state.stale.diff, null, 2)}</AppText>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void editor.rebase()}
                  disabled={state.busy}
                  className="min-h-[45px] justify-center"
                >
                  <AppText>Reload and reapply</AppText>
                </Pressable>
              </>
            ) : null}
            {state.actions?.map((action) => (
              <AppText key={action.id}>{action.description}</AppText>
            ))}
            <View className="flex-row gap-6">
              <Pressable
                accessibilityRole="button"
                disabled={state.busy}
                onPress={() => void editor.plan()}
                className="min-h-[45px] justify-center"
              >
                <AppText>Plan</AppText>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={state.busy || state.actions === null}
                onPress={() => void editor.apply()}
                className="min-h-[45px] justify-center"
              >
                <AppText>Apply</AppText>
              </Pressable>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: historyOpen }}
              onPress={() => setHistoryOpen(!historyOpen)}
              className="min-h-[45px] justify-center"
            >
              <AppText>History</AppText>
            </Pressable>
            {historyOpen
              ? history.map((revision) => (
                  <Pressable
                    key={revision.revision}
                    accessibilityRole="button"
                    onPress={() => editor.restore(revision)}
                    className="min-h-[45px] justify-center"
                  >
                    <AppText>
                      Restore {revision.writtenAt} · {revision.author}
                    </AppText>
                  </Pressable>
                ))
              : null}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
