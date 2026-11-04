import { useEnvironmentQuery } from "../../state/query";
import { meshLayoutAtoms } from "../../state/mesh-layout";
import { minuteTick } from "@t3tools/client-runtime/clock";
import { DEFAULT_SIDEBAR_WORKSPACES_CONFIG } from "@t3tools/contracts";
import { useState, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";
import {
  meshConnectionText,
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
  const now = Date.parse(
    useSyncExternalStore(minuteTick.subscribe, minuteTick.getSnapshot, minuteTick.getSnapshot),
  );
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
  return (
    <SettingsScreen title="Mesh">
      <ScreenScrollView contentContainerClassName="gap-3 px-5 py-4">
        <SettingsSection
          title={`${machines.length} ${machines.length === 1 ? "machine" : "machines"} · ${machines.filter((machine) => machine.connectedHere || machine.network?.state === "direct" || machine.network?.state === "relayed").length} online`}
        >
          <Pressable
            accessibilityRole="button"
            disabled={mesh.source === null}
            onPress={() => setEditing(true)}
            className="min-h-[45px] p-4"
          >
            <AppText>Edit config</AppText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: linkOpen }}
            onPress={() => setLinkOpen(!linkOpen)}
            className="min-h-[45px] p-4"
          >
            <AppText>Link a machine</AppText>
          </Pressable>
          {linkOpen ? (
            <MeshLinkForm links={links} machines={machines} onDone={() => setLinkOpen(false)} />
          ) : null}
        </SettingsSection>
        {machines.map((machine) => (
          <SettingsSection
            key={machine.environmentId}
            title={config?.machines[machine.environmentId]?.title ?? machine.label}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: detail === machine.environmentId }}
              onPress={() =>
                setDetail(detail === machine.environmentId ? null : machine.environmentId)
              }
              className="min-h-[45px] gap-2 p-4"
            >
              <AppText>
                {machine.tag} · {machine.label}
              </AppText>
              <AppText>
                {machine.connectedHere
                  ? "Online"
                  : (meshConnectionText(machine, machines) ?? "Offline")}
              </AppText>
              {machine.version ? <AppText>Version: {machine.version}</AppText> : null}
            </Pressable>
            {detail === machine.environmentId ? (
              <View className="gap-2 px-4 pb-4">
                <AppText>{config?.machines[machine.environmentId]?.reported?.platform.os}</AppText>
                <AppText>{meshConnectionText(machine, machines)}</AppText>
                {machine.lastError ? (
                  <AppText accessibilityRole="alert">{machine.lastError}</AppText>
                ) : null}
                <AppText>
                  {machine.replicas} {machine.replicas === 1 ? "replica" : "replicas"}
                </AppText>
                {Object.entries(config?.projectMountStatus ?? {}).flatMap(([key, statuses]) =>
                  statuses[machine.environmentId]
                    ? [
                        <AppText key={key}>
                          {config?.projectTitles[key] ?? "Project"}:{" "}
                          {statuses[machine.environmentId]?.state} ·{" "}
                          {statuses[machine.environmentId]?.message}
                        </AppText>,
                      ]
                    : [],
                )}
              </View>
            ) : null}
          </SettingsSection>
        ))}
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
                  <Pressable
                    key={machine.environmentId}
                    accessibilityRole="button"
                    onPress={() =>
                      mesh.edit((config) => forgetMachineFacts(config, machine.environmentId))
                    }
                    className="min-h-[45px] p-4"
                  >
                    <AppText>Forget {machine.label}</AppText>
                  </Pressable>
                ))
              : null}
          </SettingsSection>
        ) : null}
        <SettingsSection title="Last config apply">
          <View className="gap-2 p-4">
            {applyStatus.error ? (
              <AppText accessibilityRole="alert">{applyStatus.error}</AppText>
            ) : null}
            {applyStatus.data?.servers.flatMap((server) =>
              server.actions.map((action) => (
                <AppText key={`${server.environmentId}:${action.id}`}>
                  {action.description}: {action.state}
                  {action.reason ? ` · ${action.reason}` : ""}
                </AppText>
              )),
            )}
          </View>
        </SettingsSection>
        {editing && mesh.source ? (
          <MeshConfigSheet environmentId={mesh.source} onClose={() => setEditing(false)} />
        ) : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
