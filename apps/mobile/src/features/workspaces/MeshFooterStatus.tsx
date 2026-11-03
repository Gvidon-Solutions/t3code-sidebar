import { useSyncExternalStore } from "react";
import { useNavigation } from "@react-navigation/native";
import { Pressable } from "react-native";
import { minuteTick } from "@t3tools/client-runtime/clock";
import {
  deriveMeshFooterStatus,
  meshFooterText,
} from "@t3tools/client-runtime/state/mesh-machines";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironments } from "../../state/environments";
import { openSettings } from "../settings/settings-navigation";
import { useMeshOverview } from "./useMeshOverview";
import { useMeshLayout } from "./useMeshLayout";

export function MeshFooterStatus() {
  const navigation = useNavigation();
  const { config } = useMeshLayout();
  const { environments } = useEnvironments();
  const enabled = environments.some(
    (e) =>
      e.serverConfig?.settings.meshEnabled && e.serverConfig.settings.linkedEnvironmentsEnabled,
  );
  const { machines } = useMeshOverview({ config });
  const now = Date.parse(
    useSyncExternalStore(minuteTick.subscribe, minuteTick.getSnapshot, minuteTick.getSnapshot),
  );
  const text = meshFooterText(deriveMeshFooterStatus({ enabled, machines, now }));
  if (text === null) return null;
  return (
    <Pressable
      accessibilityLabel="Open mesh settings"
      accessibilityRole="button"
      className="min-h-[45px] justify-center px-4 py-2"
      onPress={() => openSettings(navigation, "SettingsMesh")}
    >
      <Text className="text-xs text-foreground-muted">{text}</Text>
    </Pressable>
  );
}
