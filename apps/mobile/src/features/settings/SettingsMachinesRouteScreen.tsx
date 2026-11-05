import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { useReplicaStatuses } from "../../state/meshReplicas";
import { useEnvironmentQuery } from "../../state/query";
import { meshLayoutAtoms } from "../../state/mesh-layout";
import { useNowMinuteMs } from "../../lib/clock";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import {
  meshConnectionText,
  meshMachineDetailRows,
  meshConfigApplyGroups,
  meshConfigHistory,
  partitionMeshMachines,
  forgetMachineFacts,
} from "@t3tools/client-runtime/state/mesh-machines";
import { useMeshOverview } from "../workspaces/useMeshOverview";
import { useMeshLayout } from "../workspaces/useMeshLayout";
import { MeshLinkForm } from "./MeshLinkForm";
import { MeshConfigSheet } from "./MeshConfigSheet";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { AppText } from "../../components/ui/AppText";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

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
  const applyStatus = useEnvironmentQuery(
    mesh.source ? meshLayoutAtoms.configStatus({ environmentId: mesh.source, input: {} }) : null,
  );
  const [linkOpen, setLinkOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const live = useReplicaStatuses();
  const base = config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG;
  const selected = machines.find((machine) => machine.environmentId === detail);
  const groups = meshConfigApplyGroups(
    applyStatus.data,
    meshConfigHistory(mesh.state?.snapshot?.document ?? {}),
    now,
  );
  const online = (machine: (typeof machines)[number]) =>
    machine.connectedHere ||
    machine.network?.state === "direct" ||
    machine.network?.state === "relayed";
  return (
    <SettingsScreen title="Mesh">
      <ScreenScrollView contentContainerClassName="gap-3 px-5 py-4">
        <SettingsSection
          title={`${machines.length} ${machines.length === 1 ? "machine" : "machines"} · ${machines.filter(online).length} online`}
        >
          <View className="flex-row flex-wrap gap-2 p-4">
            <Button
              label="Edit config"
              tone="primary"
              disabled={mesh.source === null}
              onPress={() => setEditing(true)}
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
                  style={{ maxWidth: 110 }}
                  className="text-xs text-foreground-muted"
                >
                  {online(machine)
                    ? machine.network?.state === "relayed"
                      ? meshConnectionText(machine, machines)
                      : "Online"
                    : (meshConnectionText(machine, machines) ??
                      (machine.lastSeenAt ? `Offline since ${machine.lastSeenAt}` : "Offline"))}
                </AppText>
                <AppText numberOfLines={1} className="text-xs text-foreground-muted">
                  {[machine.version, machine.platform?.os].filter(Boolean).join(" · ")}
                </AppText>
                <AppText>›</AppText>
              </Pressable>
              {machine.unnamed ? (
                <View className="px-4 pb-2">
                  <Button label="Name it in config" tone="text" onPress={() => setEditing(true)} />
                </View>
              ) : null}
            </View>
          ))}
        </SettingsSection>
        {selected ? (
          <Sheet title={selected.label} onClose={() => setDetail(null)}>
            <ScreenScrollView contentContainerClassName="gap-3 p-5">
              <AppText>
                Reach path:{" "}
                {meshConnectionText(selected, machines) ??
                  (online(selected) ? "Connected directly" : "Offline")}
              </AppText>
              {selected.lastError ? (
                <AppText accessibilityRole="alert">{selected.lastError}</AppText>
              ) : null}
              {meshMachineDetailRows(selected, base, live).map((row) => (
                <View key={row.label}>
                  <AppText className="text-xs text-foreground-muted">{row.label}</AppText>
                  <AppText>{row.value}</AppText>
                </View>
              ))}
              {selected.unnamed ? (
                <Button
                  label="Name it in config"
                  onPress={() => {
                    setDetail(null);
                    setEditing(true);
                  }}
                />
              ) : null}
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
        {applyStatus.error ? (
          <AppText accessibilityRole="alert">{applyStatus.error}</AppText>
        ) : null}
        {groups.map((group) => (
          <SettingsSection key={group.revision} title={group.title}>
            <View className="gap-3 p-4">
              {group.actions.map((action) => (
                <View key={`${action.server}:${action.id}`}>
                  <AppText>
                    {action.description} ·{" "}
                    {action.state === "in_progress"
                      ? "In progress"
                      : action.state === "done"
                        ? "Done"
                        : "Failed"}
                  </AppText>
                  {action.reason ? (
                    <AppText className="text-xs text-foreground-muted">{action.reason}</AppText>
                  ) : null}
                </View>
              ))}
            </View>
          </SettingsSection>
        ))}
        {editing && mesh.source ? (
          <MeshConfigSheet
            key={mesh.source}
            environmentId={mesh.source}
            onClose={() => setEditing(false)}
          />
        ) : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
