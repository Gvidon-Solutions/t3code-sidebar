import { useEffect, useSyncExternalStore } from "react";
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads persisted sends independently of draft routes
  useEffect(() => {
    void outbox.ready.catch(onError);
  }, [outbox, onError]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconciles durable pending sends with registration and connection subscriptions
  useEffect(() => {
    if (mesh && sends.some((send) => send.state !== "sent"))
      void outbox.drain(mesh, launch, openScratch).catch(onError);
  }, [mesh, sends, outbox, launch, onError, openScratch]);
  return null;
}
