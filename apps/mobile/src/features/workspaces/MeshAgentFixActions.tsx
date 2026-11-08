import * as Linking from "expo-linking";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";

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
        onPress={() => copyTextWithHaptic(props.prompt, { target: "prompt" })}
      />
    </View>
  );
}
