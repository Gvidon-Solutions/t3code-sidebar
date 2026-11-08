import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import type {
  PendingDraftMesh,
  PendingDraftOutbox,
  PendingDraftSend,
} from "@t3tools/client-runtime/state/mesh-layout";

export function PendingDraftDelivery({
  outbox,
  mesh,
  launch,
  onError,
  openScratch,
}: {
  outbox: PendingDraftOutbox;
  mesh: PendingDraftMesh | null;
  launch: (send: PendingDraftSend, projectId: string, path: string) => Promise<void>;
  onError: (error: unknown) => void;
  openScratch?: (
    environmentId: import("@t3tools/contracts").EnvironmentId,
  ) => Promise<{ id: string; workspaceRoot: string }>;
}) {
  const sends = useSyncExternalStore(outbox.subscribe, outbox.getSnapshot);
  const supportsScratch = openScratch !== undefined;
  // Callbacks are recreated on every coordinator render; events keep them out of
  // the effect keys so draining is not restarted (and re-serialized) each time.
  const reportError = useEffectEvent((error: unknown) => onError(error));
  const drainSend = useEffectEvent((send: PendingDraftSend, projectId: string, path: string) =>
    launch(send, projectId, path),
  );
  const scratch = useEffectEvent((environmentId: import("@t3tools/contracts").EnvironmentId) =>
    openScratch ? openScratch(environmentId) : Promise.reject(new Error("No scratch support")),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads persisted sends independently of draft routes
  useEffect(() => {
    void outbox.ready.catch((error: unknown) => reportError(error));
  }, [outbox]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconciles durable pending sends with registration and connection subscriptions
  useEffect(() => {
    if (mesh && sends.some((send) => send.state !== "sent"))
      void outbox
        .drain(
          mesh,
          (send, projectId, path) => drainSend(send, projectId, path),
          supportsScratch ? (environmentId) => scratch(environmentId) : undefined,
        )
        .catch((error: unknown) => reportError(error));
  }, [mesh, sends, outbox, supportsScratch]);
  return null;
}
