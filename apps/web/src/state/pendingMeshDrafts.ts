import {
  PendingDraftOutbox,
  decodePendingDraftSends,
  type PendingDraftSend,
} from "@t3tools/client-runtime/state/mesh-layout";
import { EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";

function database(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sends");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export function createPendingMeshDrafts(name: string) {
  return new PendingDraftOutbox({
    async load() {
      const db = await database(name);
      try {
        return await new Promise<readonly PendingDraftSend[]>((resolve, reject) => {
          const tx = db.transaction("sends", "readonly");
          const request = tx.objectStore("sends").get("state");
          request.onsuccess = () => {
            try {
              resolve(decodePendingDraftSends(request.result ?? []));
            } catch (error) {
              reject(error);
            }
          };
          request.onerror = () => reject(request.error);
        });
      } finally {
        db.close();
      }
    },
    async save(sends) {
      const db = await database(name);
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("sends", "readwrite");
          tx.objectStore("sends").put(sends, "state");
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error ?? new Error("Draft outbox write aborted"));
        });
      } finally {
        db.close();
      }
    },
  });
}
export const pendingMeshDrafts = createPendingMeshDrafts("t3.mesh-draft-outbox");

export function completePendingMeshDraft(send: PendingDraftSend): void {
  const draftId = DraftId.make(send.draftId);
  const store = useComposerDraftStore.getState();
  if (store.getComposerDraft(draftId)?.prompt === (send.originalPrompt ?? send.text))
    store.clearComposerContent(draftId);
  store.markDraftThreadPromoting(
    draftId,
    scopeThreadRef(EnvironmentId.make(send.environmentId), send.threadId),
  );
}

export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
