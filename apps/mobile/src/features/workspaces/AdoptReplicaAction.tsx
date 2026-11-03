import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { View } from "react-native";
import { EnvironmentId, type UnmanagedSyncSession } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { replicaStatusEnvironment } from "../../state/meshReplicas";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../../components/ui/Button";
import { AppText } from "../../components/ui/AppText";

export function AdoptReplicaAction(props: {
  readonly environmentId: string;
  readonly logicalKey: string;
}) {
  const list = useAtomCommand(replicaStatusEnvironment.unmanaged, { reportFailure: false });
  const adopt = useAtomCommand(replicaStatusEnvironment.adopt, { reportFailure: false });
  const [sessions, setSessions] = useState<readonly UnmanagedSyncSession[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const environmentId = EnvironmentId.make(props.environmentId);
  const canAdopt = useAtomValue(replicaStatusEnvironment.adopt.permissionAtom(environmentId));
  return (
    <View className="gap-2">
      <Button
        label="Adopt"
        tone="secondary"
        disabled={busy || !canAdopt}
        onPress={async () => {
          setBusy(true);
          const result = await list({ environmentId, input: {} });
          setBusy(false);
          if (result._tag === "Failure") setMessage(String(squashAtomCommandFailure(result)));
          else {
            setSessions(result.value);
            setMessage(result.value.length ? null : "No existing sync sessions on this machine.");
          }
        }}
      />
      {sessions?.map((session) => (
        <Button
          key={session.identifier}
          tone="secondary"
          disabled={busy || !canAdopt}
          label={`Adopt ${session.name ?? "existing sync"} · ${session.alpha.path} ↔ ${session.beta.path}`}
          onPress={async () => {
            setBusy(true);
            const result = await adopt({
              environmentId,
              input: { project: props.logicalKey, session: session.identifier },
            });
            setBusy(false);
            if (result._tag === "Failure") setMessage(String(squashAtomCommandFailure(result)));
            else {
              setSessions(null);
              setMessage(
                "Taking over sync. The original session stays paused until the new copy is ready.",
              );
            }
          }}
        />
      ))}
      {message ? <AppText className="text-sm text-foreground-muted">{message}</AppText> : null}
    </View>
  );
}
