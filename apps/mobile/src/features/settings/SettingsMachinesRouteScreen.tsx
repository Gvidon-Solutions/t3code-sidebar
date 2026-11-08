import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { useReplicaStatuses } from "../../state/meshReplicas";
import { useNowMinuteMs } from "../../lib/clock";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import {
  offlineMachineText,
  meshMachineDetailRows,
  partitionMeshMachines,
  forgetMachineFacts,
} from "@t3tools/client-runtime/state/mesh-machines";
import { useMeshOverview } from "../workspaces/useMeshOverview";
import { useMeshLayout } from "../workspaces/useMeshLayout";
import { MeshLinkForm } from "./MeshLinkForm";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { AppText } from "../../components/ui/AppText";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { meshProjectRows, meshSetupPrompt } from "@t3tools/client-runtime/state/mesh-machines";
import * as Linking from "expo-linking";

export function SettingsMachinesRouteScreen() {
  const mesh = useMeshLayout();
  const { config } = mesh;
  const { machines: allMachines, links } = useMeshOverview({ config });
  const now = useNowMinuteMs();
  const { active: machines, forgotten } = partitionMeshMachines(
    allMachines,
    config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    now,
  );
  const [forgottenOpen, setForgottenOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const live = useReplicaStatuses();
  const base = config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG;
  const selected = machines.find((machine) => machine.environmentId === detail);
  const online = (machine: (typeof machines)[number]) =>
    machine.connectedHere ||
    machine.network?.state === "direct" ||
    machine.network?.state === "relayed";
  const statusOf = (machine: (typeof machines)[number]) =>
    online(machine)
      ? machine.network?.state === "relayed"
        ? "Online through another machine"
        : "Online"
      : (offlineMachineText(machine.lastSeenAt) ?? "Offline");
  const setupPrompt = meshSetupPrompt(
    machines.map((machine) => ({
      label: machine.label,
      online: online(machine),
      detail: statusOf(machine),
    })),
    machines.filter((machine) => !online(machine)).map((machine) => `${machine.label} is offline`),
  );
  return (
    <SettingsScreen title="Mesh">
      <ScreenScrollView contentContainerClassName="gap-3 px-5 py-4">
        <SettingsSection
          title={`${machines.length} ${machines.length === 1 ? "machine" : "machines"} · ${machines.filter(online).length} online`}
        >
          <View className="flex-row flex-wrap gap-2 p-4">
            <Button
              label="Set up the mesh with an agent"
              tone="primary"
              onPress={() =>
                void Linking.openURL(
                  Linking.createURL("new", { queryParams: { prompt: setupPrompt } }),
                )
              }
            />
            <Button
              label="Link a machine"
              tone="secondary"
              onPress={() => setLinkOpen(!linkOpen)}
            />
          </View>
          {linkOpen ? (
            <MeshLinkForm links={links} machines={machines} onDone={() => setLinkOpen(false)} />
          ) : null}
          {machines.map((machine) => (
            <View key={machine.environmentId}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${machine.label} details`}
                onPress={() => setDetail(machine.environmentId)}
                className="min-h-[52px] flex-row items-center gap-2 border-t border-border-subtle px-4 py-3"
              >
                <AppText className="font-mono text-xs" style={{ color: machine.color }}>
                  {machine.tag}
                </AppText>
                <AppText numberOfLines={1} className="min-w-0 flex-1 font-t3-medium">
                  {machine.label}
                </AppText>
                <View
                  accessibilityElementsHidden
                  className={`size-1.5 shrink-0 rounded-full ${online(machine) ? "bg-adaptive-emerald-600-400" : "bg-foreground-muted"}`}
                />
                <AppText
                  numberOfLines={1}
                  style={{ maxWidth: 235 }}
                  className="text-xs text-foreground-muted"
                >
                  {statusOf(machine)}
                </AppText>
                <AppText>›</AppText>
              </Pressable>
            </View>
          ))}
        </SettingsSection>
        {selected ? (
          <Sheet title={selected.label} onClose={() => setDetail(null)} opaqueHeader>
            <ScreenScrollView contentContainerClassName="gap-3 p-5">
              <AppText>
                {online(selected)
                  ? selected.network?.state === "relayed"
                    ? "Online through another machine"
                    : "Online"
                  : (offlineMachineText(selected.lastSeenAt) ?? "Offline")}
              </AppText>
              <View className="gap-2">
                {meshProjectRows(base, selected.environmentId, live).map((row) => (
                  <AppText key={row.key}>{row.sentence}</AppText>
                ))}
              </View>
              <Button
                label={diagnosticsOpen ? "Hide diagnostics" : "Diagnostics"}
                tone="text"
                onPress={() => setDiagnosticsOpen(!diagnosticsOpen)}
              />
              {diagnosticsOpen
                ? meshMachineDetailRows(selected, base, live).map((row) => (
                    <View key={row.label}>
                      <AppText className="text-xs text-foreground-muted">{row.label}</AppText>
                      <AppText accessibilityHint={row.exact || undefined}>{row.value}</AppText>
                    </View>
                  ))
                : null}
            </ScreenScrollView>
          </Sheet>
        ) : null}
        {forgotten.length ? (
          <SettingsSection>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: forgottenOpen }}
              onPress={() => setForgottenOpen(!forgottenOpen)}
              className="min-h-[45px] p-4"
            >
              <AppText>Forgotten machines ({forgotten.length})</AppText>
            </Pressable>
            {forgottenOpen
              ? forgotten.map((machine) => (
                  <View
                    key={machine.environmentId}
                    className="flex-row items-center justify-between px-4 py-2"
                  >
                    <AppText>{machine.label}</AppText>
                    <Button
                      label="Forget"
                      tone="secondary"
                      onPress={() =>
                        mesh.edit((config) => forgetMachineFacts(config, machine.environmentId))
                      }
                    />
                  </View>
                ))
              : null}
          </SettingsSection>
        ) : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
