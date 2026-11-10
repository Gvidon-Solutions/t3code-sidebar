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
  sortMeshMachinesForSettings,
} from "@t3tools/client-runtime/state/mesh-machines";
import { useMeshOverview } from "../workspaces/useMeshOverview";
import { useMeshLayout } from "../workspaces/useMeshLayout";
import { useEnvironments } from "../../state/environments";
import { MeshAgentFixActions } from "../workspaces/MeshAgentFixActions";
import { machineDisplayOf } from "@t3tools/client-runtime/state/machine-display";
import { MachineTag } from "../workspaces/MachineTag";
import { MeshLinkForm } from "./MeshLinkForm";
import { MachineLinkedPeers } from "./MachineLinkedPeers";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { AppText } from "../../components/ui/AppText";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  meshProjectRows,
  meshSetupPrompt,
  meshUpdateProblems,
  meshUpdatePrompt,
  offlineMachinePrompt,
  replicaProblemPrompt,
} from "@t3tools/client-runtime/state/mesh-machines";
import * as Linking from "expo-linking";

export function SettingsMachinesRouteScreen() {
  const mesh = useMeshLayout();
  const { config } = mesh;
  const { machines: allMachines, links } = useMeshOverview({ config });
  const { environments } = useEnvironments();
  const agentEnvironmentId =
    mesh.source ??
    environments.find((environment) => environment.connection.phase === "connected")
      ?.environmentId ??
    null;
  const now = useNowMinuteMs();
  const { active, forgotten } = partitionMeshMachines(
    allMachines,
    config ?? DEFAULT_SIDEBAR_WORKSPACES_CONFIG,
    now,
  );
  // A phone has no local server, so no machine is "this machine": sort by title.
  const machines = sortMeshMachinesForSettings(active, null);
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
      : (offlineMachineText(machine.lastSeenAt ?? machine.lastExchangeAt) ?? "Offline");
  const setupPrompt = meshSetupPrompt(
    machines.map((machine) => ({
      label: machine.label,
      online: online(machine),
      detail: statusOf(machine),
    })),
    machines.filter((machine) => !online(machine)).map((machine) => `${machine.label} is offline`),
  );
  const updateProblems = meshUpdateProblems(mesh.state?.snapshot?.document ?? {});
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
              disabled={agentEnvironmentId === null}
              onPress={() => {
                if (agentEnvironmentId === null) return;
                void Linking.openURL(
                  Linking.createURL("new", {
                    queryParams: {
                      prompt: setupPrompt,
                      ...(agentEnvironmentId ? { env: agentEnvironmentId } : {}),
                    },
                  }),
                );
              }}
            />
            <Button
              label="Link a machine"
              tone="secondary"
              onPress={() => setLinkOpen(!linkOpen)}
            />
            {agentEnvironmentId === null ? (
              <AppText className="text-xs text-foreground-muted">
                Connect this phone to a machine to set up the mesh.
              </AppText>
            ) : null}
          </View>
          {linkOpen ? (
            <MeshLinkForm
              links={links}
              machines={machines}
              thisMachineId={null}
              onDone={() => setLinkOpen(false)}
            />
          ) : null}
          {machines.map((machine) => (
            <View key={machine.environmentId}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${machine.label} details`}
                onPress={() => setDetail(machine.environmentId)}
                className="min-h-[52px] flex-row items-center gap-2 border-t border-border-subtle px-4 py-3"
              >
                <MachineTag
                  machine={{ label: machine.label, tag: machine.tag, color: machine.color }}
                />
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
                  : (offlineMachineText(selected.lastSeenAt ?? selected.lastExchangeAt) ??
                    "Offline")}
              </AppText>
              {!online(selected) ? (
                <View className="gap-2">
                  <MeshAgentFixActions
                    environmentId={agentEnvironmentId}
                    accessibilityLabel={`Fix ${selected.label} offline with an agent`}
                    prompt={offlineMachinePrompt(
                      selected.label,
                      statusOf(selected),
                      selected.lastSeenAt == null && selected.lastExchangeAt == null,
                    )}
                  />
                </View>
              ) : null}
              <View className="gap-2">
                {meshProjectRows(base, selected.environmentId, live, {
                  lastKnown: !online(selected),
                }).map((row) => (
                  <View key={row.key} className="gap-2">
                    <AppText>{row.sentence}</AppText>
                    {row.canRetry ? (
                      <MeshAgentFixActions
                        environmentId={agentEnvironmentId}
                        accessibilityLabel={`Fix the copy of ${row.title} on ${selected.label} with an agent`}
                        prompt={replicaProblemPrompt(row.title, selected.label)}
                      />
                    ) : null}
                  </View>
                ))}
              </View>
              <Button
                label={diagnosticsOpen ? "Hide diagnostics" : "Diagnostics"}
                tone="text"
                onPress={() => setDiagnosticsOpen(!diagnosticsOpen)}
              />
              {diagnosticsOpen ? (
                <>
                  {meshMachineDetailRows(selected, base, live).map((row) => (
                    <View key={row.label}>
                      <AppText className="text-xs text-foreground-muted">{row.label}</AppText>
                      <AppText accessibilityHint={row.exact || undefined}>{row.value}</AppText>
                    </View>
                  ))}
                  <MachineLinkedPeers
                    machine={selected}
                    config={base}
                    links={
                      links.find((source) => source.environmentId === selected.environmentId)
                        ?.links ?? []
                    }
                  />
                </>
              ) : null}
            </ScreenScrollView>
          </Sheet>
        ) : null}
        {updateProblems.length > 0 ? (
          <SettingsSection title="Problems">
            {updateProblems.map((problem) => {
              const label = machineDisplayOf(
                base,
                problem.environmentId,
                problem.environmentId,
              ).label;
              return (
                <View key={problem.revision} className="gap-2 border-t border-border-subtle p-4">
                  <AppText>
                    Update to {problem.target} failed on {label}: {problem.reason}
                  </AppText>
                  <MeshAgentFixActions
                    environmentId={agentEnvironmentId}
                    accessibilityLabel={`Fix the update failure on ${label} with an agent`}
                    prompt={meshUpdatePrompt(problem, label)}
                  />
                </View>
              );
            })}
          </SettingsSection>
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
