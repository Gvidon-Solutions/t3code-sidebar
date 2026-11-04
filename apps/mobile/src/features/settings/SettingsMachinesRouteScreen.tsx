import { useState, useSyncExternalStore, type ReactNode } from "react";
import { minuteTick } from "@t3tools/client-runtime/clock";
import { useNavigation } from "@react-navigation/native";
import { meshMachineLastSync, setMachineReach } from "@t3tools/client-runtime/state/mesh-machines";
import { Switch } from "react-native";
import { useMeshOverview } from "../workspaces/useMeshOverview";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { MeshLinkForm } from "./MeshLinkForm";
import { meshSwitchValue, meshTogglePatch } from "./mesh-settings.logic";
import {
  machineDisplayOf,
  machineTagBackground,
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
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSidebarWorkspaces } from "../workspaces/useSidebarWorkspaces";

const COLOR_NAMES = ["Blue", "Coral", "Green", "Violet", "Amber", "Teal", "Rose", "Olive"];

function MachineEditor(props: {
  readonly children: ReactNode;
  readonly environmentId: string;
  readonly display: MachineDisplay;
  readonly configured: {
    readonly label?: string;
    readonly tag?: string;
    readonly color?: string;
    readonly aliases?: readonly string[];
  };
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
      <View className="px-4 pt-3">
        <Text
          accessibilityLabel={`Machine: ${props.display.label}`}
          className="font-mono text-xs font-t3-bold text-foreground"
          style={{
            backgroundColor: machineTagBackground(props.display.color),
            alignSelf: "flex-start",
            paddingHorizontal: 6,
            borderRadius: 4,
          }}
        >
          {props.display.tag}
        </Text>
      </View>
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm text-foreground-muted">Label</Text>
        <AppTextInput
          key={`label:${props.configured.label ?? ""}`}
          accessibilityLabel="Machine label"
          defaultValue={props.configured.label ?? ""}
          placeholder={props.serverLabel}
          autoCapitalize="words"
          autoCorrect={false}
          className="min-h-[45px] rounded-xl px-3 py-2 text-base text-foreground"
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
          className="min-h-[45px] w-24 rounded-xl px-3 py-2 text-base text-foreground"
          onEndEditing={(event) => props.onChange({ tag: event.nativeEvent.text })}
        />
        <Text className="text-xs text-foreground-muted">Up to three characters.</Text>
      </View>
      <View className="gap-3 border-t border-border-subtle px-4 py-3">
        <Text className="text-sm text-foreground-muted">Aliases</Text>
        <AppTextInput
          key={`aliases:${props.configured.aliases?.join(",") ?? ""}`}
          accessibilityLabel="Machine aliases"
          defaultValue={props.configured.aliases?.join(", ") ?? ""}
          autoCapitalize="none"
          autoCorrect={false}
          className="min-h-[45px] rounded-xl px-3 py-2 text-base text-foreground"
          onEndEditing={(event) => props.onChange({ aliases: event.nativeEvent.text.split(",") })}
        />
        <Text className="text-xs text-foreground-muted">
          Separate alternative names with commas.
        </Text>
      </View>
      <View className="gap-3 border-t border-border-subtle px-4 py-3">
        <Text className="text-sm text-foreground-muted">Color</Text>
        <View className="flex-row flex-wrap items-center gap-1">
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
                  width: 45,
                  height: 45,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <View
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    backgroundColor: color,
                    borderWidth: selected ? 3 : 0,
                    borderColor: "#ffffff",
                  }}
                />
              </Pressable>
            );
          })}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Automatic color"
            onPress={() => props.onChange({ color: null })}
            className={cn(
              "min-h-[45px] justify-center rounded-lg px-2 py-1",
              props.configured.color === undefined ? "bg-subtle-strong" : "bg-subtle",
            )}
          >
            <Text className="text-xs text-foreground-muted">Automatic</Text>
          </Pressable>
        </View>
      </View>
      {props.children}
    </SettingsSection>
  );
}

export function SettingsMachinesRouteScreen() {
  const insets = useSafeAreaInsets();
  const { config, updateConfig } = useSidebarWorkspaces();
  const { environments } = useEnvironments();
  const { machines, links } = useMeshOverview({ config });
  const navigation = useNavigation();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "mesh settings",
    reportFailure: true,
  });
  const [linkOpen, setLinkOpen] = useState(false);
  const now = Date.parse(
    useSyncExternalStore(minuteTick.subscribe, minuteTick.getSnapshot, minuteTick.getSnapshot),
  );
  const { savedConnectionsById } = useSavedRemoteConnections();
  const base = config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG;

  const serverLabel = (environmentId: string) =>
    savedConnectionsById[environmentId as EnvironmentId]?.environmentLabel ?? environmentId;

  return (
    <SettingsScreen title="Mesh">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection
          title="Use the mesh on this machine"
          footer="Shares the workspace layout and enables linked environments for work across machines."
        >
          {environments
            .filter((e) => e.connection.phase === "connected")
            .map((e) => {
              const label = machineDisplayOf(base, e.environmentId, e.label).label;
              return (
                <View key={e.environmentId} className="flex-row items-center justify-between p-4">
                  <Text numberOfLines={1} className="min-w-0 flex-1">
                    {label}
                  </Text>
                  <Switch
                    accessibilityLabel={`Use the mesh on ${label}`}
                    value={meshSwitchValue(e.serverConfig?.settings ?? {})}
                    onValueChange={(enabled) =>
                      void updateSettings({
                        environmentId: e.environmentId,
                        input: { patch: meshTogglePatch(enabled) },
                      })
                    }
                  />
                </View>
              );
            })}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: linkOpen }}
            className="min-h-[45px] p-4"
            onPress={() => setLinkOpen(!linkOpen)}
          >
            <Text>Link with…</Text>
          </Pressable>
          {linkOpen ? (
            <MeshLinkForm links={links} machines={machines} onDone={() => setLinkOpen(false)} />
          ) : null}
        </SettingsSection>
        {config === null ? (
          <SettingsSection>
            <View className="px-4 py-3">
              <Text className="text-sm text-foreground-muted">
                Connect to a server with a workspace layout to name its machines.
              </Text>
            </View>
          </SettingsSection>
        ) : null}
        {machines.map((machine) => {
          const environmentId = machine.environmentId;
          const configured = base.machines[environmentId] ?? {};
          return (
            <View key={environmentId} className="gap-2">
              <MachineEditor
                key={environmentId}
                environmentId={environmentId}
                display={machine}
                configured={configured}
                serverLabel={serverLabel(environmentId)}
                connected={machine.connectedHere}
                onChange={(patch) =>
                  updateConfig((current) => setMachineDisplay(current, environmentId, patch))
                }
              >
                <View className="gap-2 p-4">
                  <Text>This device: {machine.connectedHere ? "connected" : "not connected"}</Text>
                  <Text>
                    Linked with: {machine.linkedWith.map((e) => e.tag).join(", ") || "None"}
                  </Text>
                  {machine.version === null ? null : <Text>Version: {machine.version}</Text>}
                  <Text>{meshMachineLastSync(machine, now)}</Text>
                  {machine.lastError ? <Text>{machine.lastError}</Text> : null}
                  <Text>
                    {machine.replicas} replicas · {machine.conflicts} conflicts
                  </Text>
                  {!machine.connectedHere ? (
                    <>
                      <Text>{machine.urls.join("\n")}</Text>
                      <Pressable
                        accessibilityRole="button"
                        className="min-h-[45px] justify-center"
                        onPress={() =>
                          navigation.navigate("ConnectionsNew", {
                            initialHost: machine.urls[0] ?? "",
                          })
                        }
                      >
                        <Text>Connect this device</Text>
                      </Pressable>
                    </>
                  ) : null}
                  {machines
                    .filter((other) => other.environmentId !== environmentId)
                    .map((other) => (
                      <View key={other.environmentId} className="gap-2">
                        <Text>SSH route to {other.label}</Text>
                        <AppTextInput
                          accessibilityLabel={`SSH destination for ${other.label}`}
                          defaultValue={machine.reach[other.environmentId]?.ssh ?? ""}
                          placeholder="user@host or SSH alias"
                          onEndEditing={(e) =>
                            updateConfig((c) =>
                              setMachineReach(c, environmentId, other.environmentId, {
                                ssh: e.nativeEvent.text,
                                identityFile: machine.reach[other.environmentId]?.identityFile,
                              }),
                            )
                          }
                        />
                        <AppTextInput
                          accessibilityLabel={`Identity file for ${other.label}`}
                          defaultValue={machine.reach[other.environmentId]?.identityFile ?? ""}
                          placeholder="Identity file (optional)"
                          onEndEditing={(e) =>
                            updateConfig((c) =>
                              setMachineReach(c, environmentId, other.environmentId, {
                                ssh: machine.reach[other.environmentId]?.ssh ?? "",
                                identityFile: e.nativeEvent.text,
                              }),
                            )
                          }
                        />
                      </View>
                    ))}
                </View>
              </MachineEditor>
            </View>
          );
        })}
        {machines.length === 0 ? (
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
