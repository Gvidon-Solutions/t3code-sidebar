import {
  representationRow,
  type PendingReplicaRow,
} from "@t3tools/client-runtime/state/mesh-layout";
import { machineTagBackground } from "@t3tools/client-runtime/state/machine-display";
import type {
  ReplicaLiveStatus,
  SidebarProjectMount,
  SidebarWorkspacesConfig,
} from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";

import { Sheet } from "../../components/ui/Sheet";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Dialog from "../../components/ui/Dialog";
import type { ReplicaMachineChoice } from "@t3tools/client-runtime/state/mesh-layout";

function ReplicaTag(props: {
  readonly label: string;
  readonly tag: string;
  readonly color: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={`Machine: ${props.label}`}
      className="h-4 items-center justify-center rounded px-1"
      style={{ backgroundColor: machineTagBackground(props.color) }}
    >
      <Text className="font-mono text-[10px] font-t3-bold uppercase" style={{ color: props.color }}>
        {props.tag}
      </Text>
    </View>
  );
}

/** Fork: the phone's "Machines…" sheet for one logical project. */
export function MachinesSheet(props: {
  readonly config: SidebarWorkspacesConfig;
  readonly projectKey: string;
  readonly title: string;
  readonly liveStatuses: ReadonlyArray<ReplicaLiveStatus>;
  readonly machines: ReadonlyArray<ReplicaMachineChoice>;
  readonly onClose: () => void;
  readonly onAddReplica: (environmentId: string) => void;
  readonly onMakePrimary: (environmentId: string) => void;
  readonly onRemove: (environmentId: string) => void;
  readonly onRetry: (row: PendingReplicaRow) => void;
}) {
  const insets = useSafeAreaInsets();
  const reps: ReadonlyArray<SidebarProjectMount> =
    props.config.projectMounts[props.projectKey] ?? [];
  const present = new Set(reps.map((rep) => rep.environmentId));
  const candidates = props.machines.filter(
    (machine) => !machine.disabled && !present.has(machine.environmentId),
  );
  return (
    <Sheet title="Machines" onClose={props.onClose}>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: insets.bottom + 24,
          gap: 12,
        }}
      >
        <Text className="text-sm text-foreground-muted">
          {props.title}. Folders on each machine, and which one runs git and builds.
        </Text>
        {reps.length === 0 ? (
          <Text className="text-sm text-foreground-muted">No machines have this project yet.</Text>
        ) : null}
        {reps.map((rep) => {
          const row = representationRow(props.config, props.liveStatuses, props.projectKey, rep);
          const display = props.machines.find(
            (machine) => machine.environmentId === rep.environmentId,
          );
          const label = display?.label ?? rep.environmentId;
          const tag = display?.tag ?? rep.environmentId.slice(0, 2).toUpperCase();
          const color = display?.color ?? "#888888";
          return (
            <View
              key={rep.environmentId}
              className="gap-2 rounded-2xl border border-border bg-grouped-card p-3"
              testID={`machine-representation-${rep.environmentId}`}
            >
              <View className="flex-row items-center gap-2">
                <ReplicaTag label={label} tag={tag} color={color} />
                <Text
                  className="min-w-0 flex-1 text-base font-t3-bold text-foreground"
                  numberOfLines={1}
                >
                  {label}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {rep.role === "primary" ? "Primary" : "Replica"}
                </Text>
              </View>
              <Text className="font-mono text-xs text-foreground-muted" numberOfLines={2}>
                {rep.path}
              </Text>
              <Text
                className={
                  row.text.startsWith("Can't")
                    ? "text-xs text-danger-foreground"
                    : "text-xs text-foreground-muted"
                }
                numberOfLines={2}
              >
                {row.text}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {rep.role === "replica" ? (
                  <Button
                    label="Make primary"
                    tone="secondary"
                    onPress={() => props.onMakePrimary(rep.environmentId)}
                  />
                ) : null}
                {row.retry ? (
                  <Button
                    label="Retry"
                    tone="secondary"
                    onPress={() => {
                      if (row.retry) props.onRetry(row.retry);
                    }}
                  />
                ) : null}
                <Button
                  label="Remove"
                  tone="secondary"
                  onPress={() =>
                    Dialog.confirm({
                      title: "Remove this replica?",
                      message:
                        "The sync stops and its representation is removed. Files already on the machine stay where they are.",
                      confirmText: "Remove",
                      destructive: true,
                      onConfirm: () => props.onRemove(rep.environmentId),
                    })
                  }
                />
              </View>
            </View>
          );
        })}
        {candidates.length > 0 ? (
          <View className="gap-2 border-t border-border pt-3">
            <Text className="text-xs font-t3-medium text-foreground-muted">Add replica on…</Text>
            <View className="flex-row flex-wrap gap-2">
              {candidates.map((machine) => (
                <Pressable
                  key={machine.environmentId}
                  accessibilityRole="button"
                  accessibilityLabel={`Add replica on ${machine.label}`}
                  onPress={() => props.onAddReplica(machine.environmentId)}
                  className="flex-row items-center gap-1.5 rounded-full border border-border px-3 py-1.5"
                >
                  <ReplicaTag label={machine.label} tag={machine.tag} color={machine.color} />
                  <Text className="text-sm text-foreground">{machine.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}
