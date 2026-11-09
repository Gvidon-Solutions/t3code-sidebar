import * as Linking from "expo-linking";
import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";

/** Copies a prepared prompt, or shows it selected when the clipboard refuses the write. */
export async function copyMeshPrompt(prompt: string): Promise<boolean> {
  if (await tryCopyTextWithHaptic(prompt, { target: "prompt" })) return true;
  Dialog.prompt({
    title: "Copy the prompt by hand",
    message: "The clipboard is unavailable. The text is selected; copy it from here.",
    initialValue: prompt,
    confirmText: "Done",
    onConfirm: () => undefined,
  });
  return false;
}

/** One prepared request the owner can hand to an agent, on the machine that must fix it. */
export function MeshAgentFixActions(props: {
  readonly prompt: string;
  readonly environmentId: string | null;
  readonly label?: string;
  readonly accessibilityLabel?: string;
}) {
  const label = props.label ?? "Fix with an agent";
  return (
    <View className="flex-row flex-wrap gap-2">
      <Button
        label={label}
        size="compact"
        tone="secondary"
        accessibilityLabel={props.accessibilityLabel ?? label}
        onPress={() => {
          void Linking.openURL(
            Linking.createURL("new", {
              queryParams: {
                prompt: props.prompt,
                ...(props.environmentId ? { env: props.environmentId } : {}),
              },
            }),
          );
        }}
      />
      <Button
        label="Copy prompt"
        size="compact"
        tone="text"
        onPress={() => void copyMeshPrompt(props.prompt)}
      />
    </View>
  );
}
