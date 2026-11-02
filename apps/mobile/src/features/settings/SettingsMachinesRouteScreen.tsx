import { useAtomValue } from "@effect/atom-react";
import {
  knownMachineIds,
  machineDisplayOf,
  setMachineDisplay,
  type MachineDisplay,
  type MachineDisplayPatch,
} from "@t3tools/client-runtime/state/machine-display";
import { WORKSPACE_COLORS } from "@t3tools/client-runtime/state/sidebar-workspaces";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG, type EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSidebarWorkspaces } from "../workspaces/useSidebarWorkspaces";

const COLOR_NAMES = ["Blue", "Coral", "Green", "Violet", "Amber", "Teal", "Rose", "Olive"];

function MachineEditor(props: {
  readonly environmentId: string;
  readonly display: MachineDisplay;
  readonly configured: { readonly label?: string; readonly tag?: string; readonly color?: string };
  readonly serverLabel: string;
  readonly connected: boolean;
  readonly onChange: (patch: MachineDisplayPatch) => void;
}) {
  const selectedColor = props.configured.color ?? props.display.color;
  return (
    <SettingsSection
      title={props.display.label}
      footer={props.connected ? `Connected · ${props.environmentId}` : props.environmentId}
    >
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm text-foreground-muted">Label</Text>
        <AppTextInput
          key={`label:${props.configured.label ?? ""}`}
          accessibilityLabel="Machine label"
          defaultValue={props.configured.label ?? ""}
          placeholder={props.serverLabel}
          autoCapitalize="words"
          autoCorrect={false}
          className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
          onEndEditing={(event) => props.onChange({ label: event.nativeEvent.text })}
        />
      </View>
      <View className="gap-2 border-t border-border-subtle px-4 py-3">
        <Text className="text-sm text-foreground-muted">Tag</Text>
        <AppTextInput
          key={`tag:${props.configured.tag ?? ""}`}
          accessibilityLabel="Machine tag"
          defaultValue={props.configured.tag ?? ""}
          placeholder={props.display.tag}
          maxLength={3}
          autoCapitalize="characters"
          autoCorrect={false}
          className="min-h-10 w-24 rounded-xl px-3 py-2 text-base text-foreground"
          onEndEditing={(event) => props.onChange({ tag: event.nativeEvent.text })}
        />
        <Text className="text-xs text-foreground-muted">Up to three characters.</Text>
      </View>
      <View className="gap-3 border-t border-border-subtle px-4 py-3">
        <Text className="text-sm text-foreground-muted">Color</Text>
        <View className="flex-row flex-wrap items-center gap-3">
          {WORKSPACE_COLORS.map((color, index) => {
            const selected = selectedColor === color;
            return (
              <Pressable
                key={color}
                accessibilityRole="button"
                accessibilityLabel={`Color ${COLOR_NAMES[index] ?? color}`}
                accessibilityState={{ selected }}
                onPress={() => props.onChange({ color })}
                style={({ pressed }) => ({
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  backgroundColor: color,
                  borderWidth: selected ? 3 : 0,
                  borderColor: "#ffffff",
                  opacity: pressed ? 0.7 : 1,
                })}
              />
            );
          })}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Automatic color"
            onPress={() => props.onChange({ color: null })}
            className={cn(
              "rounded-lg px-2 py-1",
              props.configured.color === undefined ? "bg-subtle-strong" : "bg-subtle",
            )}
          >
            <Text className="text-xs text-foreground-muted">Automatic</Text>
          </Pressable>
        </View>
      </View>
    </SettingsSection>
  );
}

export function SettingsMachinesRouteScreen() {
  const insets = useSafeAreaInsets();
  const { config, updateConfig } = useSidebarWorkspaces();
  const connectedEnvironmentIds = useAtomValue(connectedEnvironmentIdsAtom);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const connected = new Set<string>(connectedEnvironmentIds);
  const base = config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG;
  const machineIds = knownMachineIds(base, connectedEnvironmentIds);
  const serverLabel = (environmentId: string) =>
    savedConnectionsById[environmentId as EnvironmentId]?.environmentLabel ?? environmentId;

  return (
    <SettingsScreen title="Machines">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {config === null ? (
          <SettingsSection>
            <View className="px-4 py-3">
              <Text className="text-sm text-foreground-muted">
                Connect to a server with a workspace layout to name its machines.
              </Text>
            </View>
          </SettingsSection>
        ) : null}
        {machineIds.map((environmentId) => {
          const configured = base.machines[environmentId] ?? {};
          return (
            <MachineEditor
              key={environmentId}
              environmentId={environmentId}
              display={machineDisplayOf(base, environmentId, serverLabel(environmentId))}
              configured={configured}
              serverLabel={serverLabel(environmentId)}
              connected={connected.has(environmentId)}
              onChange={(patch) =>
                updateConfig((current) => setMachineDisplay(current, environmentId, patch))
              }
            />
          );
        })}
        {machineIds.length === 0 ? (
          <SettingsSection>
            <View className="px-4 py-3">
              <Text className="text-sm text-foreground-muted">No machines yet.</Text>
            </View>
          </SettingsSection>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
