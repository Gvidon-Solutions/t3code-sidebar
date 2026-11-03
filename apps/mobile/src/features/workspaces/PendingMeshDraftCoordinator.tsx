import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { AttachmentCreateUploadUrlInput } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import * as Option from "effect/Option";
import {
  pendingDraftStartInput,
  uploadPendingDraftAttachments,
} from "@t3tools/client-runtime/state/mesh-layout";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { pendingMeshDrafts } from "../../state/pendingMeshDrafts";
import { threadEnvironment } from "../../state/threads";
import { projectEnvironment } from "../../state/projects";
import { attachmentEnvironment } from "../../state/attachments";
import { environmentSession } from "../../state/session";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { useServerConfigs } from "../../state/entities";
import { useReplicaStatuses } from "../../state/meshReplicas";
import { useMeshLayout } from "./useMeshLayout";

const decodeUpload = Schema.decodeUnknownSync(AttachmentCreateUploadUrlInput);

async function launchPendingMeshDraft(
  send: import("@t3tools/client-runtime/state/mesh-layout").PendingDraftSend,
  projectId: string,
): Promise<void> {
  const attachments = await uploadPendingDraftAttachments(send, async (attachment) => {
    const minted = await runAtomCommand(appAtomRegistry, attachmentEnvironment.createUploadUrl, {
      environmentId: send.environmentId,
      input: decodeUpload({
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      }),
    });
    if (minted._tag === "Failure") throw squashAtomCommandFailure(minted);
    const prepared = Option.getOrNull(
      AsyncResult.value(
        appAtomRegistry.get(environmentSession.preparedConnectionAtom(send.environmentId)),
      ),
    );
    if (!prepared || Option.isNone(prepared)) throw new Error("Machine is not connected");
    const { File, Paths, UploadType } = await import("expo-file-system");
    const file = new File(Paths.cache, `mesh-send-${send.messageId}-${attachment.id}`);
    try {
      file.create({ overwrite: true });
      await file.write(attachment.dataUrl.slice(attachment.dataUrl.indexOf(",") + 1), {
        encoding: "base64",
      });
      const response = await file.upload(
        new URL(minted.value.relativeUrl, prepared.value.httpBaseUrl).href,
        {
          httpMethod: "POST",
          uploadType: UploadType.BINARY_CONTENT,
          headers: { "Content-Type": attachment.mimeType },
        },
      );
      if (response.status < 200 || response.status >= 300)
        throw new Error(`Attachment upload failed (${response.status})`);
    } finally {
      if (file.exists) file.delete();
    }
    return minted.value.attachmentId;
  });
  const result = await runAtomCommand(appAtomRegistry, threadEnvironment.startTurn, {
    environmentId: send.environmentId,
    input: pendingDraftStartInput(send, projectId, attachments),
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
}

export function PendingMeshDraftCoordinator() {
  const mesh = useMeshLayout();
  const configs = useServerConfigs();
  const environments = useWorkspaceEnvironments();
  const statuses = useReplicaStatuses();
  const sends = useSyncExternalStore(pendingMeshDrafts.subscribe, pendingMeshDrafts.getSnapshot);
  const drain = useEffectEvent(async () => {
    if (!mesh.config) return;
    await pendingMeshDrafts.drain(
      {
        config: mesh.config,
        statuses,
        machines: new Map(
          environments.map((environment) => [
            environment.environmentId,
            {
              connected: environment.connectionState === "connected",
              config: configs.get(environment.environmentId) ?? null,
            },
          ]),
        ),
      },
      launchPendingMeshDraft,
      async (environmentId) => {
        const result = await runAtomCommand(appAtomRegistry, projectEnvironment.openScratch, {
          environmentId,
          input: {},
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      },
    );
  });
  const report = useEffectEvent((error: unknown) =>
    console.error("[mesh] Durable draft delivery failed", error),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hydrates the durable send outbox outside draft navigation lifetimes
  useEffect(() => {
    void pendingMeshDrafts.ready.catch(report);
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- external subscriptions drive durable delivery
  useEffect(() => {
    void drain().catch(report);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each external snapshot change must wake the durable delivery event
  }, [mesh.config, statuses, configs, environments, sends]);
  return null;
}
