import { useState } from "react";
import { EnvironmentId, type UnmanagedSyncSession } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { replicaStatusEnvironment } from "../../state/meshReplicas";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

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
  return (
    <div className="flex flex-col gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const result = await list({ environmentId, input: {} });
          setBusy(false);
          if (result._tag === "Failure") setMessage(String(squashAtomCommandFailure(result)));
          else {
            setSessions(result.value);
            setMessage(result.value.length ? null : "No existing sync sessions on this machine.");
          }
        }}
      >
        Adopt
      </Button>
      {sessions?.map((session) => (
        <Button
          key={session.identifier}
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={async () => {
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
        >
          Adopt {session.name ?? "existing sync"} · {session.alpha.path} ↔ {session.beta.path}
        </Button>
      ))}
      {message ? <span className="text-xs text-muted-foreground">{message}</span> : null}
    </div>
  );
}
