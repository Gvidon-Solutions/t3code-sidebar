import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  dismissMeshConnectIds,
  dismissMeshConnectPrompt,
  planMeshConnect,
  pruneMeshConnectDismissed,
  shouldShowMeshConnectPrompt,
} from "@t3tools/client-runtime/state/mesh-layout";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import * as Dialog from "../../components/ui/Dialog";
import { openSettings } from "../settings/settings-navigation";
import { useMeshLayout } from "./useMeshLayout";
import { useMeshOverview } from "./useMeshOverview";

/** First run with a mesh: one calm action to bring this device's machines online. */
export function MeshConnectPrompt() {
  const navigation = useNavigation();
  const { config } = useMeshLayout();
  const { machines } = useMeshOverview({ config });
  const { environments } = useEnvironments();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled, { reportFailure: false });
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
  const dismissed = pruneMeshConnectDismissed(
    preferences.meshConnectPromptDismissed ?? [],
    machines.map((machine) => machine.environmentId),
  );
  // Mobile gates on the same mesh settings as web before offering to reconnect.
  const enabled = environments.some(
    (environment) =>
      environment.serverConfig?.settings.meshEnabled === true &&
      environment.serverConfig.settings.linkedEnvironmentsEnabled === true,
  );
  const plan = planMeshConnect({
    machines: machines.map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
    })),
    connectedEnvironmentIds: new Set(
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => String(environment.environmentId)),
    ),
    entries: new Map(
      [...catalog.entries].map(([environmentId, entry]) => [
        String(environmentId),
        { enabled: entry.enabled },
      ]),
    ),
  });
  if (!enabled || !shouldShowMeshConnectPrompt(plan, dismissed)) return null;
  const rememberDismissed = (environmentIds: ReadonlyArray<string>) => {
    const current = preferences.meshConnectPromptDismissed ?? [];
    savePreferences({
      transform: (_value) => ({
        meshConnectPromptDismissed: dismissMeshConnectIds(current, environmentIds),
      }),
    });
  };
  const dismiss = () => {
    savePreferences({
      transform: (value) => ({
        meshConnectPromptDismissed: dismissMeshConnectPrompt(
          value.meshConnectPromptDismissed ?? [],
          plan,
        ),
      }),
    });
  };
  const connectAll = async () => {
    const settled = plan.missing.map((machine) => machine.environmentId);
    const failed: string[] = [];
    for (const machine of plan.reconnect) {
      const result = await setEnabled({
        environmentId: machine.environmentId as EnvironmentId,
        enabled: true,
      });
      if (result._tag === "Success") settled.push(machine.environmentId);
      else failed.push(machine.label);
    }
    if (settled.length > 0) rememberDismissed(settled);
    if (failed.length > 0) {
      Dialog.alert(
        "Couldn't connect every machine",
        `Ask an agent to fix the connection to ${failed.join(", ")}.`,
      );
    }
    if (plan.missing.length > 0) openSettings(navigation, "SettingsEnvironments");
  };
  return (
    <View
      testID="mesh-connect-prompt"
      className="mx-3 mb-2 gap-1 rounded-xl border border-border bg-card p-3"
    >
      <View className="flex-row items-center gap-2">
        <SymbolView name="bolt.horizontal.circle" size={18} tintColorClassName="accent-icon" />
        <Text className="min-w-0 flex-1 text-sm font-t3-medium text-foreground">
          Connect to all machines in your mesh
        </Text>
        <Pressable
          accessibilityLabel="Dismiss"
          accessibilityRole="button"
          hitSlop={8}
          className="min-h-11 min-w-11 items-center justify-center"
          onPress={dismiss}
        >
          <SymbolView name="xmark" size={13} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </View>
      <Text className="text-xs text-foreground-muted">
        {plan.missing.length > 0
          ? "This device is not connected to every machine yet."
          : "Bring this device's other machines online."}
      </Text>
      <View className="mt-1 flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          className="min-h-11 justify-center"
          onPress={() => void connectAll()}
        >
          <Text className="text-sm font-t3-medium text-primary-text">Connect all</Text>
        </Pressable>
        <Pressable accessibilityRole="button" className="min-h-11 justify-center" onPress={dismiss}>
          <Text className="text-sm text-foreground-muted">Not now</Text>
        </Pressable>
      </View>
    </View>
  );
}
