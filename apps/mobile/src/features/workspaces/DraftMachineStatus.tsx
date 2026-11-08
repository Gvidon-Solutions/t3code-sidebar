import type { ReactNode } from "react";
import type { SidebarWorkspacesConfig } from "@t3tools/contracts";
import { replicaExecutionLabel } from "@t3tools/client-runtime/state/mesh-layout";
import { Pressable, View } from "react-native";
import { AppText } from "../../components/ui/AppText";

export function DraftMachineStatus(props: {
  error?: string | null | undefined;
  preparing?: string | null | undefined;
  queued?: boolean | undefined;
  reason?: string | null | undefined;
  alternative?: string | null | undefined;
  localModel?: string | null | undefined;
  onSwitch?: (() => void) | undefined;
  onModel?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
}) {
  const message =
    props.error ??
    props.preparing ??
    (props.queued ? "Message queued. You can leave this screen." : props.reason);
  if (!message) return null;
  const label =
    !props.error && !props.preparing && !props.queued
      ? props.alternative
        ? `Switch to ${props.alternative} where it works`
        : props.localModel
          ? `Use ${props.localModel} here`
          : null
      : props.onRetry
        ? "Retry"
        : null;
  const action =
    label === "Retry" ? props.onRetry : props.alternative ? props.onSwitch : props.onModel;
  return (
    <View accessibilityRole="summary" className="flex-row flex-wrap items-center gap-1">
      <AppText textRole="footnote">{message}</AppText>
      {label && action ? (
        <Pressable accessibilityRole="button" onPress={action}>
          <AppText textRole="footnote" className="text-primary-text">
            {label}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ReplicaWorkspaceControls(props: {
  config: SidebarWorkspacesConfig | null;
  environmentId: string;
  projectId: string;
  projectEnvironmentId?: string;
  children: ReactNode;
}) {
  const isReplica =
    replicaExecutionLabel(
      props.config,
      props.environmentId,
      props.projectId,
      props.projectEnvironmentId,
    ) !== null;
  // A lite replica has no local git checkout; its controls stay hidden and no jargon is shown.
  return isReplica ? null : props.children;
}
