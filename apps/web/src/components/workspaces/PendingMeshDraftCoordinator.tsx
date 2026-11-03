import * as Schema from "effect/Schema";
import { AttachmentCreateUploadUrlInput } from "@t3tools/contracts";
import { PendingDraftDelivery } from "./PendingDraftDelivery";
import { EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  pendingDraftStartInput,
  uploadPendingDraftAttachments,
} from "@t3tools/client-runtime/state/mesh-layout";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useMeshLayout } from "../../hooks/useMeshLayout";
import { useEnvironments, useEnvironmentProviders } from "../../state/environments";
import { useReplicaStatuses } from "../../state/meshReplicas";
import { pendingMeshDrafts } from "../../state/pendingMeshDrafts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { threadEnvironment } from "../../state/threads";
import { projectEnvironment } from "../../state/projects";
import { attachmentEnvironment } from "../../state/attachments";
import { readPreparedConnection } from "../../state/session";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { toastManager } from "../ui/toast";

const decodeUpload = Schema.decodeUnknownSync(AttachmentCreateUploadUrlInput);

export function PendingMeshDraftCoordinator() {
  const mesh = useMeshLayout();
  const { environments } = useEnvironments();
  const providers = useEnvironmentProviders();
  const statuses = useReplicaStatuses();
  const report = (error: unknown) => {
    console.error("[mesh] Pending draft delivery failed", error);
    toastManager.add({
      type: "error",
      title: "Queued draft could not be sent",
      description: error instanceof Error ? error.message : String(error),
    });
  };
  const launch = async (
    send: import("@t3tools/client-runtime/state/mesh-layout").PendingDraftSend,
    projectId: string,
  ) => {
    const attachments = await uploadPendingDraftAttachments(send, async (attachment) => {
      const result = await runAtomCommand(appAtomRegistry, attachmentEnvironment.createUploadUrl, {
        environmentId: send.environmentId,
        input: decodeUpload({
          type: attachment.type,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        }),
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const connection = readPreparedConnection(send.environmentId);
      if (!connection) throw new Error("Machine is not connected");
      const bytes = Uint8Array.from(
        atob(attachment.dataUrl.slice(attachment.dataUrl.indexOf(",") + 1)),
        (character) => character.charCodeAt(0),
      );
      const response = await fetch(new URL(result.value.relativeUrl, connection.httpBaseUrl), {
        method: "POST",
        body: new Blob([bytes.buffer], { type: attachment.mimeType }),
        headers: { "Content-Type": attachment.mimeType },
      });
      if (!response.ok) throw new Error(`Attachment upload failed (${response.status})`);
      return result.value.attachmentId;
    });
    const result = await runAtomCommand(appAtomRegistry, threadEnvironment.startTurn, {
      environmentId: send.environmentId,
      input: pendingDraftStartInput(send, projectId, attachments),
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    useComposerDraftStore
      .getState()
      .markDraftThreadPromoting(
        DraftId.make(send.draftId),
        scopeThreadRef(EnvironmentId.make(send.environmentId), send.threadId),
      );
  };
  return (
    <PendingDraftDelivery
      outbox={pendingMeshDrafts}
      mesh={
        mesh.config
          ? {
              config: mesh.config,
              statuses,
              machines: new Map(
                environments.map((environment) => [
                  environment.environmentId,
                  {
                    connected: environment.connection.phase === "connected",
                    config: environment.serverConfig
                      ? {
                          settings: environment.serverConfig.settings,
                          providers: providers.get(environment.environmentId) ?? [],
                        }
                      : null,
                  },
                ]),
              ),
            }
          : null
      }
      launch={launch}
      openScratch={async (environmentId) => {
        const result = await runAtomCommand(appAtomRegistry, projectEnvironment.openScratch, {
          environmentId,
          input: {},
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      }}
      onError={report}
    />
  );
}
