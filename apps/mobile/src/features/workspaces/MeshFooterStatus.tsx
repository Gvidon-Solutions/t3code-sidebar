import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";
import { useNowMinuteMs } from "../../lib/clock";
import {
  deriveMeshFooterStatus,
  meshFooterText,
} from "@t3tools/client-runtime/state/mesh-machines";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironments } from "../../state/environments";
import { openSettings } from "../settings/settings-navigation";
import { useMeshOverview } from "./useMeshOverview";
import { useMeshLayout } from "./useMeshLayout";

/** Phone space is tight: the mesh line appears only when a machine needs attention. */
export function MeshFooterStatus() {
  const navigation = useNavigation();
  const { config } = useMeshLayout();
  const { environments } = useEnvironments();
  // Servers older than the flag omit `meshEnabled`; its contract default is on.
  const enabled = environments.some(
    (e) =>
      e.serverConfig?.settings.meshEnabled !== false &&
      e.serverConfig?.settings.linkedEnvironmentsEnabled === true,
  );
  const { machines } = useMeshOverview({ config });
  const now = useNowMinuteMs();
  const status = deriveMeshFooterStatus({ enabled, machines, now });
  if (status.kind === "hidden" || status.severity === "ok") return null;
  const text = meshFooterText(status);
  if (text === null) return null;
  return (
    <Pressable
      accessibilityLabel={text}
      accessibilityRole="button"
      accessibilityLiveRegion="polite"
      className="min-h-[36px] flex-row items-center gap-2 px-4 py-1.5"
      onPress={() => openSettings(navigation, "SettingsMesh")}
    >
      <View aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning-foreground" />
      <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-warning-foreground">
        {text}
      </Text>
    </Pressable>
  );
}
