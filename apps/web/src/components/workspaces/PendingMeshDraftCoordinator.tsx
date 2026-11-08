import * as Schema from "effect/Schema";
import { AttachmentCreateUploadUrlInput } from "@t3tools/contracts";
import { PendingDraftDelivery } from "./PendingDraftDelivery";
import {
  launchPendingDraft,
  pendingDraftMachines,
  type PendingDraftSend,
} from "@t3tools/client-runtime/state/mesh-layout";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { plainErrorMessage } from "@t3tools/client-runtime/errors";
import { useMeshLayout } from "../../hooks/useMeshLayout";
import { useEnvironments, useEnvironmentProviders } from "../../state/environments";
import { useReplicaStatuses } from "../../state/meshReplicas";
import { pendingMeshDrafts, completePendingMeshDraft } from "../../state/pendingMeshDrafts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { threadEnvironment } from "../../state/threads";
import { projectEnvironment } from "../../state/projects";
import { attachmentEnvironment } from "../../state/attachments";
import { readPreparedConnection } from "../../state/session";
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
      description: plainErrorMessage(error),
    });
  };
  const launch = async (send: PendingDraftSend, projectId: string) => {
    await launchPendingDraft({
      send,
      projectId,
      upload: async (attachment) => {
        const result = await runAtomCommand(
          appAtomRegistry,
          attachmentEnvironment.createUploadUrl,
          {
            environmentId: send.environmentId,
            input: decodeUpload({
              type: attachment.type,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            }),
          },
        );
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
      },
      startTurn: async (input) => {
        const result = await runAtomCommand(appAtomRegistry, threadEnvironment.startTurn, {
          environmentId: send.environmentId,
          input,
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      },
    });
    completePendingMeshDraft(send);
  };
  return (
    <PendingDraftDelivery
      outbox={pendingMeshDrafts}
      mesh={
        mesh.config
          ? {
              config: mesh.config,
              statuses,
              machines: pendingDraftMachines(
                environments.map((environment) => ({
                  environmentId: environment.environmentId,
                  connected: environment.connection.phase === "connected",
                  config: environment.serverConfig
                    ? {
                        settings: environment.serverConfig.settings,
                        providers: providers.get(environment.environmentId) ?? [],
                      }
                    : null,
                })),
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
